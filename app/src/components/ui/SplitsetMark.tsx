import type { ColorValue } from 'react-native';
import Svg, { Path } from 'react-native-svg';

// The logo's two slanted panels (assets/images/logo-source.png) as plain shapes on a 24 grid: the
// top one up and to the left, the bottom one down and to the right, a sliver of gap between them
// so they still read as two dashes at tab-bar size.
const TOP = 'M10.4 1.8H22L12.8 11.2H1.2Z';
const BOTTOM = 'M12.6 12.8H23L13.8 22.2H3.4Z';

/** The Splitset mark without its pictures: two solid slanted dashes in one colour (the Today tab's icon). */
export function SplitsetMark({ size = 24, color }: { size?: number; color: ColorValue }) {
  return (
    // no accessibility props here: react-native-svg hands them to the web page as bogus attributes;
    // the tab button around it already names the tab
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d={TOP} fill={color} />
      <Path d={BOTTOM} fill={color} />
    </Svg>
  );
}
