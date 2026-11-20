# Hosting ltm mcp for Copilot Studio

Copilot Studio agents and declarative agents can't run `ltm` or read a Bank checkout, but they can call an MCP server over HTTP. This guide deploys `ltm mcp --http` on Azure Container Apps behind Easy Auth and connects a Copilot Studio agent to it. [ADR 0007](../docs/adr/0007-a-hosted-ltm-trusts-its-front-door.md) records why `ltm` leaves caller authentication to the front door.

## What It Serves

`ltm mcp --http` serves four read tools over stateless Streamable HTTP at `/mcp`: `query`, `head`, `read`, and `facets`. It serves one Bank, which the environment picks with `LTM_BANK_URL` or `LTM_BANK_PATH`. The write tools (`propose`, `amend`, and `validate`) aren't registered, and a call to one fails as an unknown tool. The tools take no `bank` argument, so a caller can't switch Banks.

A Copilot Studio agent that calls `query` can filter by Facet and status, which the Digest in [M365 Copilot](m365-copilot.md) can't do. Its answers match what `ltm query` prints, and [Retrieval](retrieval.md) describes the filters.

In a container the server's working directory maps to no git repo, so `ltm` can't tell which repo's Records a `query` wants. Set `LTM_CONSUMER_REPO=<org>/<repo>`, and a `query` with no `facets` returns the rows `ltm query` prints from a checkout of that repo, whatever the server's working directory. The server refuses to start when the value isn't in `<org>/<repo>` form. A `query` that passes `facets`, the Facets in a Record's `applies_to`, gets those Facets' Records instead. A team with several Consumer repos can run one server per repo, or leave the variable unset and tell its agents, in their instructions, to pass `facets`. [ADR 0010](../docs/adr/0010-a-hosted-ltm-takes-its-consumer-repo-from-the-environment.md) records why.

## Who Can Read

Everyone the front door admits reads every Record in the Bank, so the agent's audience is the Bank's audience. A narrower audience needs a separate Bank and a separate server.

## Build the Image

From a checkout of this repo, build the image against a release that includes `ltm mcp --http`:

```sh
docker build --build-arg LTM_VERSION=<version> -t ltm-mcp .
```

`<version>` is a release tag. `ltm mcp --http` first ships in the release after v0.4.0, so no earlier tag works. The build downloads that release's `ltm-linux-x64` binary and checks it against the release's `SHA256SUMS`. A binary whose checksum doesn't match fails the build. The image carries `git` for the Bank clone and no SSH client. Push the result to a registry the container app can pull from, such as Azure Container Registry.

## Read-Only Clone Credential

The server clones the Bank on its first call, so it needs a credential that can read that one repo and nothing else. Create a fine-grained personal access token with `Contents: Read-only` on the Bank repo alone, and put it in the clone URL:

```text
https://x-access-token:<token>@github.com/<org>/<bank>.git
```

Store that URL in a `Key Vault` secret that the container app reads through a managed identity, and never in the image, the app's plain environment, or a command line. `ltm` redacts the credential from its errors, so a failed clone doesn't hand it to a caller.

A read-only deploy key also works for a Bank on SSH, but the image ships no SSH client. The token is the supported route.

## Keep the Clone URL Off the Command Line

Passing the URL with `--secrets bank-url="$BANK_URL"` puts the token in `az`'s process arguments, where any local user who can list processes can read it. Instead, write the URL to a `Key Vault` secret from a file and let the container app read that secret through a user-assigned managed identity. Run this section and the next in one shell, because the deploy command reuses `IDENTITY_ID`.

Create the `Key Vault` with role-based access, and give yourself the role that lets you write secrets to it:

```sh
az keyvault create --name <vault> --resource-group <group> --enable-rbac-authorization true
VAULT_ID=$(az keyvault show --name <vault> --query id --output tsv)
az role assignment create --role "Key Vault Secrets Officer" --scope "$VAULT_ID" \
  --assignee-object-id "$(az ad signed-in-user show --query id --output tsv)" --assignee-principal-type User
```

A new role assignment can take up to 10 minutes to apply. Until it does, the `az keyvault secret set` command below returns Forbidden.

In bash or zsh, `read` and `printf` are shell builtins, so the URL reaches no other process's arguments, and nothing echoes while you paste. Run the `read` line on its own, paste the clone URL, and press Enter. Pasted together with the lines after it, `read` takes the next line as the URL, and the URL you paste then runs at the shell prompt, which puts the token in your history:

```sh
read -rs BANK_URL
```

Then run the rest as one block. The `if` refuses an empty or unset `BANK_URL`, which would otherwise upload an empty secret and exit 0. The first `rm -f` clears any older `bank-url.txt`, because `umask` doesn't change the mode of a file that already exists, so the new file is readable by you alone. The last `rm` deletes it after `az keyvault secret set` runs, whether or not the upload worked. `--output none` keeps `az` from printing the stored value back to your terminal:

```sh
if [ -z "$BANK_URL" ]; then
  echo 'BANK_URL is empty: run read -rs BANK_URL again' >&2
else
  rm -f bank-url.txt
  (umask 077 && printf '%s' "$BANK_URL" > bank-url.txt)
  unset BANK_URL
  az keyvault secret set --vault-name <vault> --name bank-url --file bank-url.txt --output none
  rm bank-url.txt
fi
```

If `az keyvault secret set` returns Forbidden, wait, then repeat both blocks starting from `read -rs BANK_URL`, because the second block has already cleared `BANK_URL` and deleted the file.

Next, create the identity the app uses and let it read secrets from the `Key Vault`:

```sh
az identity create --name ltm-mcp-id --resource-group <group>
IDENTITY_ID=$(az identity show --name ltm-mcp-id --resource-group <group> --query id --output tsv)
az role assignment create --role "Key Vault Secrets User" --scope "$VAULT_ID" \
  --assignee-object-id "$(az identity show --name ltm-mcp-id --resource-group <group> --query principalId --output tsv)" \
  --assignee-principal-type ServicePrincipal
```

The `Key Vault Secrets User` assignment takes the same time to apply, so if the deploy below can't fetch the secret, wait and rerun the deploy command.

To rotate the token, repeat both blocks starting from `read -rs BANK_URL`. The app uses a versionless secret URI, so it picks up the new version within 30 minutes and restarts any revision that reads the secret from an environment variable.

This route adds a `Key Vault`, an identity, and two role assignments to the resource group. You need permission to write role assignments on the `Key Vault`, which Owner, User Access Administrator, and Role Based Access Control Administrator all grant. `Key Vault` Standard bills secret operations per 10,000 transactions with no setup fee. Because the secret is versionless, the app [re-reads it within 30 minutes](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets) to catch a new version, so it reads the secret on that schedule as well as when a revision starts, and the cost stays small.

## Deploy with az containerapp

This creates the app with external ingress on port 8080. `--secrets` holds a reference to the `Key Vault` secret, and `identityref:` names the identity that reads it. `secretref:` points `LTM_BANK_URL` at that secret. The `ENTRYPOINT` leaves out `--trust-proxy-auth` on purpose, so a bare `docker run` refuses to start. Container Apps appends `--args` after the `ENTRYPOINT`, which is where the flag goes:

```sh
az containerapp create --name ltm-mcp --resource-group <group> --environment <environment> \
  --image <registry>/ltm-mcp:<version> --registry-server <registry> \
  --ingress external --target-port 8080 \
  --user-assigned "$IDENTITY_ID" \
  --secrets "bank-url=keyvaultref:https://<vault>.vault.azure.net/secrets/bank-url,identityref:$IDENTITY_ID" \
  --env-vars LTM_BANK_URL=secretref:bank-url LTM_CONSUMER_REPO=<org>/<repo> \
  --args "--trust-proxy-auth"
```

Add `--registry-username` and `--registry-password` if the registry needs them. Read the app's address with `az containerapp show --name ltm-mcp --resource-group <group> --query properties.configuration.ingress.fqdn`. The app's logs show `ltm mcp: serving http://0.0.0.0:8080/mcp` once the server is up.

`--trust-proxy-auth` tells `ltm` that a front door authenticates callers, and until the next step turns on Easy Auth, none does. In between, anyone who finds the app's address can read the Bank, so run the Easy Auth step straight away.

## Easy Auth

Register an Entra app for the API, give it an Application ID URI such as `api://<client-id>`, and expose a scope on it. Then open the app's manifest and set `requestedAccessTokenVersion` to `2`. Left null, it means 1, and a v1 token's issuer is `https://sts.windows.net/<tenant-id>/`, which Easy Auth rejects against the v2 issuer below. A v2 token's `aud` claim is the API's client id rather than its `api://` URI, so allow the client id. Last, add a client secret under the registration's Certificates & secrets and copy its value.

Passing the value with `--client-secret` would put it in `az`'s process arguments, where any local user who can list processes can read it. Store the value in the same `Key Vault` instead, and give Easy Auth the name of a container app secret that reads it from there. Run these commands in the shell from [Keep the Clone URL Off the Command Line](#keep-the-clone-url-off-the-command-line), because they reuse `IDENTITY_ID`. As with the clone URL, run the `read` line on its own, paste the client secret, and press Enter:

```sh
read -rs ENTRA_SECRET
```

Then run the block that writes it to the `Key Vault`, which follows the clone URL's block line for line:

```sh
if [ -z "$ENTRA_SECRET" ]; then
  echo 'ENTRA_SECRET is empty: run read -rs ENTRA_SECRET again' >&2
else
  rm -f entra-secret.txt
  (umask 077 && printf '%s' "$ENTRA_SECRET" > entra-secret.txt)
  unset ENTRA_SECRET
  az keyvault secret set --vault-name <vault> --name entra-client-secret --file entra-secret.txt --output none
  rm entra-secret.txt
fi
```

Next, add a container app secret that references the `Key Vault` secret through the app's identity, and turn on the Microsoft provider with `--client-secret-name` pointing at it. The `Key Vault Secrets User` assignment from earlier already covers the new secret:

```sh
az containerapp secret set --name ltm-mcp --resource-group <group> \
  --secrets "entra-client-secret=keyvaultref:https://<vault>.vault.azure.net/secrets/entra-client-secret,identityref:$IDENTITY_ID"
az containerapp auth microsoft update --name ltm-mcp --resource-group <group> \
  --client-id <client-id> --client-secret-name entra-client-secret \
  --issuer https://login.microsoftonline.com/<tenant-id>/v2.0 \
  --allowed-audiences <client-id> --yes
```

Then require authentication and answer an unauthenticated request with 401 rather than a redirect to a login page, which an agent can't follow:

```sh
az containerapp auth update --name ltm-mcp --resource-group <group> \
  --enabled true --unauthenticated-client-action Return401 --yes
```

A `curl -X POST https://<fqdn>/mcp` with no token should now return 401 from Easy Auth, and `ltm` never sees the request. Microsoft Learn doesn't document the token Copilot Studio presents. If a call that carries a token still gets 401, decode the token and compare its `iss` and `aud` with the issuer and audience above.

## Copilot Studio

In the agent, open Tools, choose Add a tool, then New tool, then Model Context Protocol. Fill in the server name and description, and set the server URL to `https://<fqdn>/mcp`. Choose OAuth 2.0 with the Manual type, and enter:

- Client ID and client secret: a second Entra app registration for Copilot Studio, which acts as the OAuth client.
- Authorization URL: `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/authorize`
- Token URL template: `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token`
- Refresh URL: the same as the token URL.
- Scopes: the API's scope, such as `api://<client-id>/<scope-name>`, which you expose on the API's app registration.

Select Create, copy the callback URL Copilot Studio shows, and add it to the client app registration as a Web redirect URI. Grant the client app permission to the API's scope. Then create the connection and add the tool to the agent.

A declarative agent uses Entra single sign-on against the same front door, with the same audience and the same Bank. Microsoft's docs don't confirm how Copilot Studio handles stateless JSON responses or the `filters` input schema, so check a real `query` call before you hand the agent to anyone.

## Run It Locally

To try the server without a container, point it at a Bank checkout. A bare port binds `127.0.0.1`, and the server refuses requests whose `Host` header names another host, so a web page in your browser can't reach the Bank through DNS rebinding:

```sh
LTM_BANK_PATH=/path/to/bank ltm mcp --http 8080
```

The server prints `ltm mcp: serving http://127.0.0.1:8080/mcp` on stderr. A non-loopback host such as `0.0.0.0:8080` exits 1 unless you pass `--trust-proxy-auth`, and it exits 1 before binding when neither `LTM_BANK_URL` nor `LTM_BANK_PATH` is set.
