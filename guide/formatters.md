# Formatters and Record Frontmatter

Prettier, oxfmt, and the Obsidian Linter all rewrite YAML frontmatter at their default settings. This page shows how to stop each one from touching a Record's frontmatter while it still formats the Markdown body. Format a Record's body as much as you like, but leave its frontmatter alone.

## Why Frontmatter Stays Canonical

Records keep their frontmatter in canonical form, with flat values and every list on a single line. Agents find Records with plain grep, so a search for `service:order-service` has to land on the line that starts with `applies_to:`. A list split across lines breaks that search, and formatters split them. `ltm validate` also checks canonical form. It reports a split list as a `canonical-list` error and exits `1`. At default settings, Prettier 3.9.10 and oxfmt 0.72.0 both took the six-entry `applies_to` list in `fixtures/formatter/before/shared-queue-for-events-aB3cD4eF5g.md` and spread it over nine lines, with the brackets on lines of their own. Both also rewrote `title: 'Log fields use snake_case'` to double quotes. Each change leaves valid YAML that is no longer in canonical form.

The body has no such constraint. Reflowed lists and added blank lines in the prose don't affect retrieval or validation.

## Prettier

Prettier formats YAML frontmatter as an embedded language inside Markdown. Turning `embeddedLanguageFormatting` off for Records leaves their frontmatter byte-identical and still formats the body. Merge this entry into the `overrides` array of the `.prettierrc.json` at your repo root:

```json
{
  "overrides": [
    {
      "files": "_memory/**/*.md",
      "options": { "embeddedLanguageFormatting": "off" }
    }
  ]
}
```

The glob resolves against the directory that holds the config file. If your Records live somewhere other than `_memory/`, change the glob to match. Prettier still formats the frontmatter of Markdown files outside that path.

## oxfmt

oxfmt formats Markdown too, so it needs the same override. It takes the same option name, with `files` written as an array. Merge this entry into the `overrides` array of your `.oxfmtrc.json`:

```json
{
  "overrides": [
    {
      "files": ["_memory/**/*.md"],
      "options": { "embeddedLanguageFormatting": "off" }
    }
  ]
}
```

## Obsidian Linter

If you open a Bank in Obsidian, add the folder that holds your Records to the Linter's "Folders to ignore" setting. The Linter then skips every file under that folder, body included, on save, on focused file change, and when it lints all files. The "Lint the current file" command doesn't check the setting, so use "Lint the current file unless ignored" instead. The Linter matches each entry against the start of the file's path, measured from the folder you opened in Obsidian. If you opened the Bank itself, enter `_memory`. When the Bank sits deeper inside the folder you opened, enter the full path to `_memory`.

To keep linting Record bodies instead, leave the folder linted and turn off each rule below. All of them except Compact YAML belong to the Linter's YAML group. Compact YAML sits in the Spacing group. By default it removes blank lines at the start and end of the frontmatter. With its "Inner new lines" option turned on, it also removes the blank lines in between.

- Add blank line after YAML
- Compact YAML
- Dedupe YAML array values
- Escape YAML special characters
- Force YAML escape
- Format tags in YAML
- Format YAML array
- Insert YAML attributes
- Move inline fields to YAML
- Move tags to YAML
- Remove YAML keys
- Sort YAML array values
- YAML key sort
- YAML timestamp
- YAML title
- YAML title alias

These rules apply to every file under the folder you opened in Obsidian, so this route also stops them on notes that aren't Records.

## The Backstop: `ltm fmt --check`

Overrides cover only the tools you've configured. A contributor with a different editor, or a formatter that ignores your config, can still reflow a Record. Run `ltm fmt --check` in pre-commit as the backstop. Its job is to catch a Record whose frontmatter has drifted out of canonical form before the commit lands. `ltm fmt` then puts that Record back. `ltm fmt --check` prints the path of each drifted Record and exits `1`, which stops the commit.
