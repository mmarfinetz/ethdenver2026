export interface DrawBuffer {
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly cellWidth: number;
  readonly cellHeight: number;

  set(x: number, y: number, z?: number): void;
  line(x0: number, y0: number, x1: number, y1: number, z0?: number, z1?: number): void;
  clear(): void;
}
