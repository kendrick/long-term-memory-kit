# Hosting ltm mcp for Copilot Studio

Copilot Studio agents and declarative agents can't run `ltm` or read a Bank checkout, but they can call an MCP server over HTTP. This guide deploys `ltm mcp --http` on Azure Container Apps behind Easy Auth and connects a Copilot Studio agent to it. [ADR 0007](../docs/adr/0007-a-hosted-ltm-trusts-its-front-door.md) records why `ltm` leaves caller authentication to the front door.

## What It Serves

`ltm mcp --http` serves four read tools over stateless Streamable HTTP at `/mcp`: `query`, `head`, `read`, and `facets`. It serves one Bank, which the environment picks with `LTM_BANK_URL` or `LTM_BANK_PATH`. The write tools (`propose`, `amend`, and `validate`) aren't registered, and a call to one fails as an unknown tool. The tools take no `bank` argument, so a caller can't switch Banks.

A Copilot Studio agent that calls `query` can filter by Facet and status, which the Digest in [M365 Copilot](m365-copilot.md) can't do. Its answers match what `ltm query` prints, and [Retrieval](retrieval.md) describes the filters.

In a container the server's working directory maps to no git repo, so a `query` with no Facet or filter returns only Org-wide Records. Callers should pass `facets`, the Facets in a Record's `applies_to`, to see a repo's Records. Tell the agent that in its instructions.

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

Store that URL as a Container Apps secret and never in the image or the app's plain environment. `ltm` redacts the credential from its errors, so a failed clone doesn't hand it to a caller.

A read-only deploy key also works for a Bank on SSH, but the image ships no SSH client. The token is the supported route.

## Deploy with az containerapp

This creates the app with external ingress on port 8080. `--secrets` holds the clone URL, and `secretref:` points `LTM_BANK_URL` at it. The `ENTRYPOINT` leaves out `--trust-proxy-auth` on purpose, so a bare `docker run` refuses to start. Container Apps appends `--args` after the `ENTRYPOINT`, which is where the flag goes:

```sh
az containerapp create --name ltm-mcp --resource-group <group> --environment <environment> \
  --image <registry>/ltm-mcp:<version> --registry-server <registry> \
  --ingress external --target-port 8080 \
  --secrets bank-url="$LTM_BANK_URL" \
  --env-vars LTM_BANK_URL=secretref:bank-url \
  --args "--trust-proxy-auth"
```

Add `--registry-username` and `--registry-password` if the registry needs them. Read the app's address with `az containerapp show --name ltm-mcp --resource-group <group> --query properties.configuration.ingress.fqdn`. The app's logs show `ltm mcp: serving http://0.0.0.0:8080/mcp` once the server is up.

`--trust-proxy-auth` tells `ltm` that a front door authenticates callers, and until the next step turns on Easy Auth, none does. In between, anyone who finds the app's address can read the Bank, so run the Easy Auth step straight away.

## Easy Auth

Register an Entra app for the API, give it an Application ID URI such as `api://<client-id>`, and expose a scope on it. Then open the app's manifest and set `requestedAccessTokenVersion` to `2`. Left null, it means 1, and a v1 token's issuer is `https://sts.windows.net/<tenant-id>/`, which Easy Auth rejects against the v2 issuer below. A v2 token's `aud` claim is the API's client id rather than its `api://` URI, so allow the client id. Now turn on the Microsoft provider for the container app:

```sh
az containerapp auth microsoft update --name ltm-mcp --resource-group <group> \
  --client-id <client-id> --client-secret "$CLIENT_SECRET" \
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
