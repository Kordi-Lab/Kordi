import { forwardRef } from 'react'
import { cn } from '@/lib/utils'

const variants = {
  default: 'app-button-primary',
  secondary: 'app-control-chip',
  outline: 'app-button-outline',
}

const sizes = {
  default: 'h-10 px-4 py-2',
  sm: 'h-9 px-3',
  icon: 'h-10 w-10 p-0',
}

export const Button = forwardRef(function Button(
  { className, variant = 'default', size = 'default', type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
        variants[variant] ?? variants.default,
        sizes[size] ?? sizes.default,
        className,
      )}
      {...props}
    />
  )
})
