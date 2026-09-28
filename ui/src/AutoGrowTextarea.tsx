import { type TextareaHTMLAttributes, useLayoutEffect, useRef } from 'react'

// A textarea as tall as its text, so a long slice scope is read in full instead of
// through a three-line window. The owner can still drag it taller.
export function AutoGrowTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }, [props.value])
  return <textarea ref={ref} {...props} />
}
