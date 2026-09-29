import React from 'react'
import { Path } from 'react-native-svg'
import ReactNativeSvg, { Props } from './ReactNativeSvg'

const ScrollToBottomIcon: React.FC<Props> = (props: Props) => {
  return (
    <ReactNativeSvg
      {...props}
      color={props.color || 'currentColor'}
      fill={props.fill || 'currentColor'}
      stroke={props.stroke || 'currentColor'}
      strokeWidth='0'
      viewBox={props.viewBox || '0 0 16 16'}
      width={props.width || '200px'}
      height={props.height || '200px'}
      transform={props.transform}
    >
      <Path
        fillRule='evenodd'
        d='M8 1a.5.5 0 0 1 .5.5v11.793l3.146-3.147a.5.5 0 0 1 .708.708l-4 4a.5.5 0 0 1-.708 0l-4-4a.5.5 0 0 1 .708-.708L7.5 13.293V1.5A.5.5 0 0 1 8 1'
      ></Path>
    </ReactNativeSvg>
  )
}

export default ScrollToBottomIcon
