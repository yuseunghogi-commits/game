// 테스트에서 쓰는 Node 내장 모듈 최소 선언 (@types/node 없이)
declare module 'node:fs' { export function readFileSync(p: string): Uint8Array; export function readFileSync(p: string, enc: string): string; }
declare module 'node:zlib' { export function gunzipSync(b: Uint8Array): Uint8Array & { buffer: ArrayBuffer; byteOffset: number; byteLength: number }; }
