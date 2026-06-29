import React from 'react'
import { cn } from '@/lib/utils'

export const ScrollArea = React.forwardRef(function ScrollArea({ className, ...props }, ref) {
  return <div ref={ref} className={cn('app-scroll-area min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain', className)} {...props} />
})
