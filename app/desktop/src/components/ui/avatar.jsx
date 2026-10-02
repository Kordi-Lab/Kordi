import { cn } from '@/lib/utils'

export function Avatar({ className, ...props }) {
  return <div className={cn('relative flex shrink-0 items-center justify-center overflow-hidden rounded-[17%]', className)} {...props} />
}

export function AvatarFallback({ className, ...props }) {
  return <div className={cn('flex h-full w-full items-center justify-center rounded-[17%]', className)} {...props} />
}
