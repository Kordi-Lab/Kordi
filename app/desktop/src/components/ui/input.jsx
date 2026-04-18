import { forwardRef } from 'react'
import { cn } from '@/lib/utils'

export const Input = forwardRef(function Input({ className, ...props }, ref) {
  return (
      <input
        ref={ref}
        className={cn(
          'app-input-shell flex h-10 w-full rounded-md px-3 py-2 text-sm text-[color:var(--utility-foreground)] outline-none placeholder:text-[color:var(--utility-muted-text)]',
          className,
        )}
        {...props}
      />
  )
})
