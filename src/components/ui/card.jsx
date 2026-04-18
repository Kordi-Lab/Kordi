import { cn } from '@/lib/utils'

export function Card({ className, ...props }) {
  return <div className={cn('rounded-xl border border-white/10 bg-card text-white shadow-sm', className)} {...props} />
}

export function CardHeader({ className, ...props }) {
  return <div className={cn('flex flex-col space-y-1.5 p-4 pb-2', className)} {...props} />
}

export function CardTitle({ className, ...props }) {
  return <div className={cn('text-base font-semibold leading-none tracking-tight', className)} {...props} />
}

export function CardContent({ className, ...props }) {
  return <div className={cn('p-4 pt-0', className)} {...props} />
}
