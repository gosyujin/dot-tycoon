/** '#rrggbb' */
export type Hex = string;

export type HairLength = 'bald' | 'buzz' | 'short' | 'medium' | 'long';
/** 前髪。left/right は「画像で見て髪が被っている側」 */
export type Fringe = 'none' | 'part' | 'left' | 'right' | 'full';
export type HairVolume = 0 | 1 | 2;
export type EyeStyle = 'open' | 'wide' | 'closed' | 'happy';
export type MouthStyle = 'neutral' | 'smile' | 'grin' | 'open';
export type GlassesStyle = 'none' | 'round' | 'square' | 'sun';
export type BgMode = 'photo' | 'hair' | 'transparent';

/**
 * 写真から読み取った「特徴」。16×16 のドット絵は、この値だけから描かれる。
 * （写真のピクセルを縮小するのではなく、特徴から描き直す）
 */
export interface Features {
  hairColor: Hex;
  skinColor: Hex;
  eyeColor: Hex;
  lipColor: Hex;
  clothesColor: Hex;
  /** 写真の背景の代表色（bgMode が 'photo' のときに淡色化して使う） */
  bgColor: Hex;
  bgMode: BgMode;

  hairLength: HairLength;
  hairVolume: HairVolume;
  fringe: Fringe;

  eyes: EyeStyle;
  mouth: MouthStyle;
  blush: boolean;

  glasses: GlassesStyle;
  glassesColor: Hex;
}

export const DEFAULT_FEATURES: Features = {
  hairColor: '#4f8ef7',
  skinColor: '#ffe3cf',
  eyeColor: '#2b2d42',
  lipColor: '#c0475a',
  clothesColor: '#7fb0ff',
  bgColor: '#cfe0ff',
  bgMode: 'photo',
  hairLength: 'short',
  hairVolume: 0,
  fringe: 'part',
  eyes: 'open',
  mouth: 'neutral',
  blush: true,
  glasses: 'none',
  glassesColor: '#2b2d42',
};
