// MediaPipe Face Landmarker（468点 + 虹彩10点）のインデックス。
// 「右目」は被写体から見て右 = 画像では左側（x が小さい側）。

export const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150,
  136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];

// 輪郭を一周する順（ポリゴンとして使う）
export const RIGHT_EYE = [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7];
export const LEFT_EYE = [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249];
export const RIGHT_BROW = [46, 53, 52, 65, 55, 107, 66, 105, 63, 70];
export const LEFT_BROW = [276, 283, 282, 295, 285, 336, 296, 334, 293, 300];
export const LIPS_OUTER = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146];
export const LIPS_INNER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95];

export const RIGHT_IRIS_CENTER = 468;
export const RIGHT_IRIS_RING = [469, 470, 471, 472];
export const LEFT_IRIS_CENTER = 473;
export const LEFT_IRIS_RING = [474, 475, 476, 477];

export const FOREHEAD_TOP = 10;
export const CHIN = 152;
export const RIGHT_EYE_OUTER = 33;
export const RIGHT_EYE_INNER = 133;
export const LEFT_EYE_INNER = 362;
export const LEFT_EYE_OUTER = 263;
export const RIGHT_CHEEK = 205;
export const LEFT_CHEEK = 425;
export const FOREHEAD_MID = 151;

/** selfie_multiclass_256x256 のクラス */
export const SEG = { BACKGROUND: 0, HAIR: 1, BODY_SKIN: 2, FACE_SKIN: 3, CLOTHES: 4, OTHERS: 5 } as const;
