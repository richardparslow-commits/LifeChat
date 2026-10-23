/**
 * Minimal iconv-lite replacement for the Workers bundle.
 *
 * Express 4 pulls iconv-lite in through body-parser → raw-body. Its CommonJS
 * entry lazily requires `./streams`, which constructs a Node Transform stream
 * when iconv-lite is loaded. Workers can run Node HTTP servers but that lazy
 * dynamic require does not survive esbuild's CommonJS wrapper.
 *
 * raw-body only needs `getDecoder` for JSON request bodies, which are UTF-8.
 * The Web `TextDecoder` covers UTF-8 and the other encodings it supports; an
 * unsupported label throws the same "Encoding not recognized" message raw-body
 * translates into a 415.
 */

'use strict';

function normalize(encoding) {
  const label = String(encoding || 'utf-8').toLowerCase();
  if (label === 'utf8') return 'utf-8';
  if (label === 'utf16le' || label === 'ucs2' || label === 'ucs-2') return 'utf-16le';
  return label;
}

function getDecoder(encoding) {
  let decoder;
  try {
    decoder = new TextDecoder(normalize(encoding));
  } catch {
    throw new Error(`Encoding not recognized: '${encoding}'`);
  }
  return {
    write(chunk) {
      return decoder.decode(chunk, { stream: true });
    },
    end() {
      return decoder.decode();
    },
  };
}

function encodingExists(encoding) {
  try {
    new TextDecoder(normalize(encoding));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  getDecoder,
  encodingExists,
  // Kept for callers that only check the capability flag; no stream adapters
  // are provided because request bodies are fully buffered before decoding.
  supportsStreams: false,
};
