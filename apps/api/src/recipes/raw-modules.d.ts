// Vite `?raw` imports, used by the tests to load HTML fixtures as strings inside the Workers pool.
declare module '*.html?raw' {
  const content: string;
  export default content;
}
