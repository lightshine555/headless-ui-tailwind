// WAI-ARIA: https://www.w3.org/TR/wai-aria-practices-1.2/#dialog_modal
import React, {
  createContext,
  createRef,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,

  // Types
  ContextType,
  ElementType,
  MouseEvent as ReactMouseEvent,
  MutableRefObject,
  Ref,
} from 'react'

import { Props } from '../../types'
import { match } from '../../utils/match'
import { forwardRefWithAs, render, Features, PropsForFeatures } from '../../utils/render'
import { useSyncRefs } from '../../hooks/use-sync-refs'
import { Keys } from '../keyboard'
import { isDisabledReactIssue7711 } from '../../utils/bugs'
import { useId } from '../../hooks/use-id'
import { FocusTrap } from '../../components/focus-trap/focus-trap'
import { useInertOthers } from '../../hooks/use-inert-others'
import { Portal } from '../../components/portal/portal'
import { ForcePortalRoot } from '../../internal/portal-force-root'
import { Description, useDescriptions } from '../description/description'
import { useOpenClosed, State } from '../../internal/open-closed'
import { useServerHandoffComplete } from '../../hooks/use-server-handoff-complete'
import { StackProvider, StackMessage } from '../../internal/stack-context'
import { useOutsideClick } from '../../hooks/use-outside-click'
import { useOwnerDocument } from '../../hooks/use-owner'
import { useEventListener } from '../../hooks/use-event-listener'
import { Hidden, Features as HiddenFeatures } from '../../internal/hidden'
import { useEvent } from '../../hooks/use-event'
import { disposables } from '../../utils/disposables'
import { isIOS } from '../../utils/platform'

enum DialogStates {
  Open,
  Closed,
}

interface StateDefinition {
  titleId: string | null
  panelRef: MutableRefObject<HTMLDivElement | null>
}

enum ActionTypes {
  SetTitleId,
}

type Actions = { type: ActionTypes.SetTitleId; id: string | null }

let reducers: {
  [P in ActionTypes]: (
    state: StateDefinition,
    action: Extract<Actions, { type: P }>
  ) => StateDefinition
} = {
  [ActionTypes.SetTitleId](state, action) {
    if (state.titleId === action.id) return state
    return { ...state, titleId: action.id }
  },
}

let DialogContext = createContext<
  | [
      {
        dialogState: DialogStates
        close(): void
        setTitleId(id: string | null): void
      },
      StateDefinition
    ]
  | null
>(null)
DialogContext.displayName = 'DialogContext'

function useDialogContext(component: string) {
  let context = useContext(DialogContext)
  if (context === null) {
    let err = new Error(`<${component} /> is missing a parent <Dialog /> component.`)
    if (Error.captureStackTrace) Error.captureStackTrace(err, useDialogContext)
    throw err
  }
  return context
}

function useScrollLock(
  ownerDocument: Document | null,
  enabled: boolean,
  resolveAllowedContainers: () => HTMLElement[] = () => [document.body]
) {
  useEffect(() => {
    if (!enabled) return
    if (!ownerDocument) return

    let d = disposables()
    let scrollPosition = window.pageYOffset

    function style(node: HTMLElement, property: string, value: string) {
      let previous = node.style.getPropertyValue(property)
      Object.assign(node.style, { [property]: value })
      return d.add(() => {
        Object.assign(node.style, { [property]: previous })
      })
    }

    let documentElement = ownerDocument.documentElement
    let ownerWindow = ownerDocument.defaultView ?? window

    let scrollbarWidthBefore = ownerWindow.innerWidth - documentElement.clientWidth
    style(documentElement, 'overflow', 'hidden')

    if (scrollbarWidthBefore > 0) {
      let scrollbarWidthAfter = documentElement.clientWidth - documentElement.offsetWidth
      let scrollbarWidth = scrollbarWidthBefore - scrollbarWidthAfter
      style(documentElement, 'paddingRight', `${scrollbarWidth}px`)
    }

    if (isIOS()) {
      style(ownerDocument.body, 'marginTop', `-${scrollPosition}px`)
      window.scrollTo(0, 0)

      // Relatively hacky, but if you click a link like `<a href="#foo">` in the Dialog, and there
      // exists an element on the page (outside of the Dialog) with that id, then the browser will
      // scroll to that position. However, this is not the case if the element we want to scroll to
      // is higher and the browser needs to scroll up, but it doesn't do that.
      //
      // Let's try and capture that element and store it, so that we can later scroll to it once the
      // Dialog closes.
      let scrollToElement: HTMLElement | null = null
      d.addEventListener(
        ownerDocument,
        'click',
        (e) => {
          if (e.target instanceof HTMLElement) {
            try {
              let anchor = e.target.closest('a')
              if (!anchor) return
              let { hash } = new URL(anchor.href)
              let el = ownerDocument.querySelector(hash)
              if (el && !resolveAllowedContainers().some((container) => container.contains(el))) {
                scrollToElement = el as HTMLElement
              }
            } catch (err) {}
          }
        },
        true
      )

      d.addEventListener(
        ownerDocument,
        'touchmove',
        (e) => {
          // Check if we are scrolling inside any of the allowed containers, if not let's cancel the event!
          if (
            e.target instanceof HTMLElement &&
            !resolveAllowedContainers().some((container) =>
              container.contains(e.target as HTMLElement)
            )
          ) {
            e.preventDefault()
          }
        },
        { passive: false }
      )

      // Restore scroll position
      d.add(() => {
        // Before opening the Dialog, we capture the current pageYOffset, and offset the page with
        // this value so that we can also scroll to `(0, 0)`.
        //
        // If we want to restore a few things can happen:
        //
        // 1. The window.pageYOffset is still at 0, this means nothing happened, and we can safely
        // restore to the captured value earlier.
        // 2. The window.pageYOffset is **not** at 0. This means that something happened (e.g.: a
        // link was scrolled into view in the background). Ideally we want to restore to this _new_
        // position. To do this, we can take the new value into account with the captured value from
        // before.
        //
        // (Since the value of window.pageYOffset is 0 in the first case, we should be able to
        // always sum these values)
        window.scrollTo(0, window.pageYOffset + scrollPosition)

        // If we captured an element that should be scrolled to, then we can try to do that if the
        // element is still connected (aka, still in the DOM).
        if (scrollToElement && scrollToElement.isConnected) {
          scrollToElement.scrollIntoView({ block: 'nearest' })
          scrollToElement = null
        }
      })
    }

    return d.dispose
  }, [ownerDocument, enabled])
}

function stateReducer(state: StateDefinition, action: Actions) {
  return match(action.type, reducers, state, action)
}

// ---

let DEFAULT_DIALOG_TAG = 'div' as const
interface DialogRenderPropArg {
  open: boolean
}
type DialogPropsWeControl = 'role' | 'aria-modal' | 'aria-describedby' | 'aria-labelledby'

let DialogRenderFeatures = Features.RenderStrategy | Features.Static

let DialogRoot = forwardRefWithAs(function Dialog<
  TTag extends ElementType = typeof DEFAULT_DIALOG_TAG
>(
  props: Props<TTag, DialogRenderPropArg, DialogPropsWeControl> &
    PropsForFeatures<typeof DialogRenderFeatures> & {
      open?: boolean
      onClose(value: boolean): void
      initialFocus?: MutableRefObject<HTMLElement | null>
      __demoMode?: boolean
    },
  ref: Ref<HTMLDivElement>
) {
  let internalId = useId()
  let {
    id = `headlessui-dialog-${internalId}`,
    open,
    onClose,
    initialFocus,
    __demoMode = false,
    ...theirProps
  } = props
  let [nestedDialogCount, setNestedDialogCount] = useState(0)

  let usesOpenClosedState = useOpenClosed()
  if (open === undefined && usesOpenClosedState !== null) {
    // Update the `open` prop based on the open closed state
    open = match(usesOpenClosedState, {
      [State.Open]: true,
      [State.Closed]: false,
    })
  }

  let containers = useRef<Set<MutableRefObject<HTMLElement | null>>>(new Set())
  let internalDialogRef = useRef<HTMLDivElement | null>(null)
  let dialogRef = useSyncRefs(internalDialogRef, ref)

  // Reference to a node in the "main" tree, not in the portalled Dialog tree.
  let mainTreeNode = useRef<HTMLDivElement | null>(null)

  let ownerDocument = useOwnerDocument(internalDialogRef)

  // Validations
  let hasOpen = props.hasOwnProperty('open') || usesOpenClosedState !== null
  let hasOnClose = props.hasOwnProperty('onClose')
  if (!hasOpen && !hasOnClose) {
    throw new Error(
      `You have to provide an \`open\` and an \`onClose\` prop to the \`Dialog\` component.`
    )
  }

  if (!hasOpen) {
    throw new Error(
      `You provided an \`onClose\` prop to the \`Dialog\`, but forgot an \`open\` prop.`
    )
  }

  if (!hasOnClose) {
    throw new Error(
      `You provided an \`open\` prop to the \`Dialog\`, but forgot an \`onClose\` prop.`
    )
  }

  if (typeof open !== 'boolean') {
    throw new Error(
      `You provided an \`open\` prop to the \`Dialog\`, but the value is not a boolean. Received: ${open}`
    )
  }

  if (typeof onClose !== 'function') {
    throw new Error(
      `You provided an \`onClose\` prop to the \`Dialog\`, but the value is not a function. Received: ${onClose}`
    )
  }

  let dialogState = open ? DialogStates.Open : DialogStates.Closed

  let [state, dispatch] = useReducer(stateReducer, {
    titleId: null,
    descriptionId: null,
    panelRef: createRef(),
  } as StateDefinition)

  let close = useEvent(() => onClose(false))

  let setTitleId = useEvent((id: string | null) => dispatch({ type: ActionTypes.SetTitleId, id }))

  let ready = useServerHandoffComplete()
  let enabled = ready ? (__demoMode ? false : dialogState === DialogStates.Open) : false
  let hasNestedDialogs = nestedDialogCount > 1 // 1 is the current dialog
  let hasParentDialog = useContext(DialogContext) !== null

  // If there are multiple dialogs, then you can be the root, the leaf or one
  // in between. We only care abou whether you are the top most one or not.
  let position = !hasNestedDialogs ? 'leaf' : 'parent'

  // Ensure other elements can't be interacted with
  useInertOthers(internalDialogRef, hasNestedDialogs ? enabled : false)

  let resolveContainers = useEvent(() => {
    // Third party roots
    let rootContainers = Array.from(
      ownerDocument?.querySelectorAll('body > *, [data-headlessui-portal]') ?? []
    ).filter((container) => {
      if (!(container instanceof HTMLElement)) return false // Skip non-HTMLElements
      if (container.contains(mainTreeNode.current)) return false // Skip if it is the main app
      if (state.panelRef.current && container.contains(state.panelRef.current)) return false
      return true // Keep
    })

    return [...rootContainers, state.panelRef.current ?? internalDialogRef.current] as HTMLElement[]
  })

  // Close Dialog on outside click
  useOutsideClick(() => resolveContainers(), close, enabled && !hasNestedDialogs)

  // Handle `Escape` to close
  useEventListener(ownerDocument?.defaultView, 'keydown', (event) => {
    if (event.defaultPrevented) return
    if (event.key !== Keys.Escape) return
    if (dialogState !== DialogStates.Open) return
    if (hasNestedDialogs) return
    event.preventDefault()
    event.stopPropagation()
    close()
  })

  // Scroll lock
  useScrollLock(
    ownerDocument,
    dialogState === DialogStates.Open && !hasParentDialog,
    resolveContainers
  )

  // Trigger close when the FocusTrap gets hidden
  useEffect(() => {
    if (dialogState !== DialogStates.Open) return
    if (!internalDialogRef.current) return

    let observer = new IntersectionObserver((entries) => {
      for (let entry of entries) {
        if (
          entry.boundingClientRect.x === 0 &&
          entry.boundingClientRect.y === 0 &&
          entry.boundingClientRect.width === 0 &&
          entry.boundingClientRect.height === 0
        ) {
          close()
        }
      }
    })

    observer.observe(internalDialogRef.current)

    return () => observer.disconnect()
  }, [dialogState, internalDialogRef, close])

  let [describedby, DescriptionProvider] = useDescriptions()

  let contextBag = useMemo<ContextType<typeof DialogContext>>(
    () => [{ dialogState, close, setTitleId }, state],
    [dialogState, state, close, setTitleId]
  )

  let slot = useMemo<DialogRenderPropArg>(
    () => ({ open: dialogState === DialogStates.Open }),
    [dialogState]
  )

  let ourProps = {
    ref: dialogRef,
    id,
    role: 'dialog',
    'aria-modal': dialogState === DialogStates.Open ? true : undefined,
    'aria-labelledby': state.titleId,
    'aria-describedby': describedby,
  }

  return (
    <StackProvider
      type="Dialog"
      enabled={dialogState === DialogStates.Open}
      element={internalDialogRef}
      onUpdate={useEvent((message, type, element) => {
        if (type !== 'Dialog') return

        match(message, {
          [StackMessage.Add]() {
            containers.current.add(element)
            setNestedDialogCount((count) => count + 1)
          },
          [StackMessage.Remove]() {
            containers.current.add(element)
            setNestedDialogCount((count) => count - 1)
          },
        })
      })}
    >
      <ForcePortalRoot force={true}>
        <Portal>
          <DialogContext.Provider value={contextBag}>
            <Portal.Group target={internalDialogRef}>
              <ForcePortalRoot force={false}>
                <DescriptionProvider slot={slot} name="Dialog.Description">
                  <FocusTrap
                    initialFocus={initialFocus}
                    containers={containers}
                    features={
                      enabled
                        ? match(position, {
                            parent: FocusTrap.features.RestoreFocus,
                            leaf: FocusTrap.features.All & ~FocusTrap.features.FocusLock,
                          })
                        : FocusTrap.features.None
                    }
                  >
                    {render({
                      ourProps,
                      theirProps,
                      slot,
                      defaultTag: DEFAULT_DIALOG_TAG,
                      features: DialogRenderFeatures,
                      visible: dialogState === DialogStates.Open,
                      name: 'Dialog',
                    })}
                  </FocusTrap>
                </DescriptionProvider>
              </ForcePortalRoot>
            </Portal.Group>
          </DialogContext.Provider>
        </Portal>
      </ForcePortalRoot>
      <Hidden features={HiddenFeatures.Hidden} ref={mainTreeNode} />
    </StackProvider>
  )
})

// ---

let DEFAULT_OVERLAY_TAG = 'div' as const
interface OverlayRenderPropArg {
  open: boolean
}
type OverlayPropsWeControl = 'aria-hidden' | 'onClick'

let Overlay = forwardRefWithAs(function Overlay<
  TTag extends ElementType = typeof DEFAULT_OVERLAY_TAG
>(props: Props<TTag, OverlayRenderPropArg, OverlayPropsWeControl>, ref: Ref<HTMLDivElement>) {
  let internalId = useId()
  let { id = `headlessui-dialog-overlay-${internalId}`, ...theirProps } = props
  let [{ dialogState, close }] = useDialogContext('Dialog.Overlay')
  let overlayRef = useSyncRefs(ref)

  let handleClick = useEvent((event: ReactMouseEvent) => {
    if (event.target !== event.currentTarget) return
    if (isDisabledReactIssue7711(event.currentTarget)) return event.preventDefault()
    event.preventDefault()
    event.stopPropagation()
    close()
  })

  let slot = useMemo<OverlayRenderPropArg>(
    () => ({ open: dialogState === DialogStates.Open }),
    [dialogState]
  )

  let ourProps = {
    ref: overlayRef,
    id,
    'aria-hidden': true,
    onClick: handleClick,
  }

  return render({
    ourProps,
    theirProps,
    slot,
    defaultTag: DEFAULT_OVERLAY_TAG,
    name: 'Dialog.Overlay',
  })
})

// ---

let DEFAULT_BACKDROP_TAG = 'div' as const
interface BackdropRenderPropArg {
  open: boolean
}
type BackdropPropsWeControl = 'aria-hidden' | 'onClick'

let Backdrop = forwardRefWithAs(function Backdrop<
  TTag extends ElementType = typeof DEFAULT_BACKDROP_TAG
>(props: Props<TTag, BackdropRenderPropArg, BackdropPropsWeControl>, ref: Ref<HTMLDivElement>) {
  let internalId = useId()
  let { id = `headlessui-dialog-backdrop-${internalId}`, ...theirProps } = props
  let [{ dialogState }, state] = useDialogContext('Dialog.Backdrop')
  let backdropRef = useSyncRefs(ref)

  useEffect(() => {
    if (state.panelRef.current === null) {
      throw new Error(
        `A <Dialog.Backdrop /> component is being used, but a <Dialog.Panel /> component is missing.`
      )
    }
  }, [state.panelRef])

  let slot = useMemo<BackdropRenderPropArg>(
    () => ({ open: dialogState === DialogStates.Open }),
    [dialogState]
  )

  let ourProps = {
    ref: backdropRef,
    id,
    'aria-hidden': true,
  }

  return (
    <ForcePortalRoot force>
      <Portal>
        {render({
          ourProps,
          theirProps,
          slot,
          defaultTag: DEFAULT_BACKDROP_TAG,
          name: 'Dialog.Backdrop',
        })}
      </Portal>
    </ForcePortalRoot>
  )
})

// ---

let DEFAULT_PANEL_TAG = 'div' as const
interface PanelRenderPropArg {
  open: boolean
}

let Panel = forwardRefWithAs(function Panel<TTag extends ElementType = typeof DEFAULT_PANEL_TAG>(
  props: Props<TTag, PanelRenderPropArg>,
  ref: Ref<HTMLDivElement>
) {
  let internalId = useId()
  let { id = `headlessui-dialog-panel-${internalId}`, ...theirProps } = props
  let [{ dialogState }, state] = useDialogContext('Dialog.Panel')
  let panelRef = useSyncRefs(ref, state.panelRef)

  let slot = useMemo<PanelRenderPropArg>(
    () => ({ open: dialogState === DialogStates.Open }),
    [dialogState]
  )

  // Prevent the click events inside the Dialog.Panel from bubbling through the React Tree which
  // could submit wrapping <form> elements even if we portalled the Dialog.
  let handleClick = useEvent((event: ReactMouseEvent) => {
    event.stopPropagation()
  })

  let ourProps = {
    ref: panelRef,
    id,
    onClick: handleClick,
  }

  return render({
    ourProps,
    theirProps,
    slot,
    defaultTag: DEFAULT_PANEL_TAG,
    name: 'Dialog.Panel',
  })
})

// ---

let DEFAULT_TITLE_TAG = 'h2' as const
interface TitleRenderPropArg {
  open: boolean
}

let Title = forwardRefWithAs(function Title<TTag extends ElementType = typeof DEFAULT_TITLE_TAG>(
  props: Props<TTag, TitleRenderPropArg>,
  ref: Ref<HTMLHeadingElement>
) {
  let internalId = useId()
  let { id = `headlessui-dialog-title-${internalId}`, ...theirProps } = props
  let [{ dialogState, setTitleId }] = useDialogContext('Dialog.Title')

  let titleRef = useSyncRefs(ref)

  useEffect(() => {
    setTitleId(id)
    return () => setTitleId(null)
  }, [id, setTitleId])

  let slot = useMemo<TitleRenderPropArg>(
    () => ({ open: dialogState === DialogStates.Open }),
    [dialogState]
  )

  let ourProps = { ref: titleRef, id }

  return render({
    ourProps,
    theirProps,
    slot,
    defaultTag: DEFAULT_TITLE_TAG,
    name: 'Dialog.Title',
  })
})

// ---

export let Dialog = Object.assign(DialogRoot, { Backdrop, Panel, Overlay, Title, Description })
