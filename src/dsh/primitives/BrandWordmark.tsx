/**
 * PIDesktop: DeepSeek's wordmark artwork is not carried over. The export stays
 * so the package's index keeps its shape; nothing in PIDesktop renders it.
 */
import type { IconProps } from './icons/props.ts'

export interface BrandWordmarkProps extends IconProps {
  includeMark?: boolean | undefined
}

export function BrandWordmark(_props: BrandWordmarkProps) {
  return null
}
