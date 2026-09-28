import { type TextareaHTMLAttributes, useLayoutEffect, useRef } from 'react'

const grow = (el: HTMLTextAreaElement): void => {
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight + 2}px`
}

// A textarea as tall as its text, so a long slice scope is read in full instead of
// through a three-line window. The owner can still drag it taller. Works controlled (value) and
// uncontrolled (defaultValue): it also grows on every input event.
export function AutoGrowTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const { onInput } = props
  useLayoutEffect(() => {
    if (ref.current) grow(ref.current)
  }, [props.value, props.defaultValue])
  const input: TextareaHTMLAttributes<HTMLTextAreaElement>['onInput'] = (e) => {
    grow(e.currentTarget)
    onInput?.(e)
  }
  return <textarea ref={ref} {...props} onInput={input} />
}
