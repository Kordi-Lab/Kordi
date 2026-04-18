import { cn } from '@/lib/utils'

const variants = {
  default: 'app-badge-primary',
  secondary: 'app-control-chip',
  outline: 'app-button-outline',
}

export function Badge({ className, variant = 'default', ...props }) {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-md border px-2.5 py-0.5 text-xs font-medium',
        variants[variant] ?? variants.default,
        className,
      )}
      {...props}
    />
  )
}
