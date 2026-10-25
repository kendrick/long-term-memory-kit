// Bun embeds a `with { type: "text" }` import as a string; bun-types declares *.txt but not *.md.
declare module "*.md" {
  const text: string;
  export default text;
}
