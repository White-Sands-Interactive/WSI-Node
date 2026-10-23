export type Tile = "." | "T";

export class Forest {
  readonly width: number;
  readonly height: number;
  private readonly tiles: Tile[];

  constructor(width = 5, height = 5) {
    this.width = width;
    this.height = height;
    this.tiles = Array.from({ length: width * height }, () => "." as Tile);
    // One tree at (2, 2)
    this.set(2, 2, "T");
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  get(x: number, y: number): Tile {
    if (!this.inBounds(x, y)) throw new Error(`Out of bounds: ${x},${y}`);
    return this.tiles[y * this.width + x]!;
  }

  set(x: number, y: number, tile: Tile): void {
    if (!this.inBounds(x, y)) throw new Error(`Out of bounds: ${x},${y}`);
    this.tiles[y * this.width + x] = tile;
  }

  treesLeft(): number {
    return this.tiles.filter((t) => t === "T").length;
  }

  render(): string {
    const rows: string[] = [];
    for (let y = 0; y < this.height; y++) {
      let row = "";
      for (let x = 0; x < this.width; x++) {
        row += this.get(x, y);
      }
      rows.push(row);
    }
    return rows.join("\n");
  }
}
