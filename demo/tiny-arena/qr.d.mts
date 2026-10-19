// Type declarations for qr.mjs so TypeScript tests can use it under strict.
export interface QrCode {
  version: number;
  size: number;
  modules: boolean[][];
}

export type EccLevel = 'L' | 'M' | 'Q' | 'H';

export declare const MAX_VERSION: number;
export declare function encodeQr(text: string, options?: { ecc?: EccLevel }): QrCode;
export declare function toSvg(qr: QrCode, options?: { border?: number; scale?: number }): string;
export declare function gfMul(a: number, b: number): number;
export declare function rsGenerator(degree: number): number[];
export declare function rsCheck(data: number[], degree: number): number[];
