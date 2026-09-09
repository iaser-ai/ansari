import React from 'react';
import Svg, { Path } from 'react-native-svg';
import {
  ANSARI_MARK_ASPECT_RATIO,
  ANSARI_MARK_DECORATIVE_PROPS,
  ANSARI_MARK_PATHS,
  ANSARI_MARK_VIEWBOX,
} from '@/constants/ansariMark';

/**
 * The standalone Ansari symbol, flat. The source artwork is white for
 * presentation use, but the app mark follows the scheme's hero ink
 * instead. Keep the symbol decorative: the adjacent product name is the
 * accessible label.
 *
 * Both places the mark is worn on its own — the desktop rail and the
 * phone hero's lockup — wear `AnsariMarkBrass` instead: the same
 * artwork, struck as metal. This flat rendering is what remains for
 * anywhere the mark must be a single solid colour.
 */

export function AnsariWordmark({
  height = 96,
  color,
}: {
  height?: number;
  color: string;
}) {
  return (
    <Svg
      width={height * ANSARI_MARK_ASPECT_RATIO}
      height={height}
      viewBox={`0 0 ${ANSARI_MARK_VIEWBOX.width} ${ANSARI_MARK_VIEWBOX.height}`}
      {...ANSARI_MARK_DECORATIVE_PROPS}
    >
      {ANSARI_MARK_PATHS.map((d, i) => (
        <Path key={i} d={d} fill={color} />
      ))}
    </Svg>
  );
}
