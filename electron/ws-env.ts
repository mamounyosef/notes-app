// Must load before the ws library: once bundled, ws's optional native
// helpers (bufferutil, utf-8-validate) resolve to empty stubs and Realtime
// crashes with "mask is not a function". Use its plain JavaScript paths.
process.env.WS_NO_BUFFER_UTIL = '1'
process.env.WS_NO_UTF_8_VALIDATE = '1'

export {}
