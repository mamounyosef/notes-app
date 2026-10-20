// Library files that HTML blocks load as text (see vite.config.ts aliases), and untyped packages.
declare module 'vendor-chart-umd?raw' {
  const src: string
  export default src
}
declare module 'vendor-katex-umd?raw' {
  const src: string
  export default src
}
declare module 'wavedrom'
declare module 'wavedrom/skins/dark.js'
