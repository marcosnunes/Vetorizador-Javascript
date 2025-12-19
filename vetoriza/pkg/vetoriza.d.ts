declare namespace wasm_bindgen {
	/* tslint:disable */
	/* eslint-disable */
	export function vetorizar_imagem(base64_img: string): string;
	/**
	 * Sample position for subsampled chroma
	 */
	export enum ChromaSamplePosition {
	  /**
	   * The source video transfer function must be signaled
	   * outside the AV1 bitstream.
	   */
	  Unknown = 0,
	  /**
	   * Horizontally co-located with (0, 0) luma sample, vertically positioned
	   * in the middle between two luma samples.
	   */
	  Vertical = 1,
	  /**
	   * Co-located with (0, 0) luma sample.
	   */
	  Colocated = 2,
	}
	/**
	 * Chroma subsampling format
	 */
	export enum ChromaSampling {
	  /**
	   * Both vertically and horizontally subsampled.
	   */
	  Cs420 = 0,
	  /**
	   * Horizontally subsampled.
	   */
	  Cs422 = 1,
	  /**
	   * Not subsampled.
	   */
	  Cs444 = 2,
	  /**
	   * Monochrome.
	   */
	  Cs400 = 3,
	}
	/**
	 * Allowed pixel value range
	 *
	 * C.f. `VideoFullRangeFlag` variable specified in ISO/IEC 23091-4/ITU-T H.273
	 */
	export enum PixelRange {
	  /**
	   * Studio swing representation
	   */
	  Limited = 0,
	  /**
	   * Full swing representation
	   */
	  Full = 1,
	}
	export enum Tune {
	  Psnr = 0,
	  Psychovisual = 1,
	}
	
}

declare type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

declare interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly vetorizar_imagem: (a: number, b: number) => [number, number];
  readonly __wbindgen_export_0: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_start: () => void;
}

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
declare function wasm_bindgen (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
