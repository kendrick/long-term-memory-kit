This repo is the {{name}} Bank. It holds Records that apply to more than one repo. Each Record is one Markdown file with YAML frontmatter, filed in its memory type's folder: {{types}}.

## Find the Records That Apply

Run these commands from the Bank root, in this order. List the folders, then grep the frontmatter to narrow the list. Next, read the header of each Record that's left with `ltm head` or `head -n 20`. Read the full file only after its header shows that the Record applies.

```sh
{{funnel}}
```

## Check Status Before You Act

A Record with `status: proposed` is a Proposal. Read it as context, never as a constraint. Skip any Record whose status is `superseded`, `deprecated`, or `rejected`.

## Facet Prefixes

`applies_to` and `owners` hold Facets written as `<prefix>:<value>`. This Bank declares these prefixes: {{prefixes}}.

## Frontmatter Fields

{{fields}}

## Propose a Record

To add a Record or change one, submit a Proposal in any of these ways:

- Run `ltm propose`.
- Call the `propose` tool on the ltm MCP server.
- Open a PR by hand that adds the Record with `status: proposed`.
