// Wrangler bundles `.html` imports as text.
declare module '*.html' {
  const text: string;
  export default text;
}
