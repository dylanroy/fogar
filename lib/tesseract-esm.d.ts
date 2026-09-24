// The browser bundle of tesseract.js exports the same object as the package entry, as a default export.
declare module 'tesseract.js/dist/tesseract.esm.min.js' {
  const tesseract: typeof import('tesseract.js');
  export default tesseract;
}
