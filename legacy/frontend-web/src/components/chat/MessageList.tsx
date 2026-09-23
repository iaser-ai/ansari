import { ScrollToBottomIcon } from '@/components/svg'
import { useScreenInfo } from '@/hooks'
import { Message, RootState, Thread, UserRole } from '@/store'
import { Helpers } from '@/utils'
import React, { forwardRef, useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Platform, Pressable, ScrollView, View } from 'react-native'
import { useSelector } from 'react-redux'
import MessageBubble, { MessageBubbleProps } from './MessageBubble'

// Within this many pixels of the bottom the reader counts as being at the bottom.
const AT_BOTTOM_THRESHOLD_PX = 50

// Memoize MessageBubble to avoid unnecessary re-renders
const areEqual = (prevProps: MessageBubbleProps, nextProps: MessageBubbleProps) =>
  prevProps.isOutgoing === nextProps.isOutgoing &&
  prevProps.isSending === nextProps.isSending &&
  prevProps.message.id === nextProps.message.id &&
  prevProps.message.timestamp === nextProps.message.timestamp

const MessageBubbleMemo = React.memo(MessageBubble, areEqual)

interface MessageListProps {
  activeThread: Thread | null
  isLoading: boolean
  isSending: boolean
  scrollToBottomEnabled?: boolean
  reactionsEnabled?: boolean
  width?: string | number
  isShare?: boolean
}

export interface MessageListRef {
  scrollToBottom: () => void
}

/**
 * MessageList component renders a list of chat messages efficiently.
 * It includes performance optimizations such as memoization and dynamic
 * scroll-to-bottom functionality. It also handles loading states and
 * provides a smooth user experience across web and mobile platforms using React Native Web.
 */

const MessageList = forwardRef<MessageListRef, MessageListProps>(
  (
    { isLoading, activeThread, isSending, reactionsEnabled = true, scrollToBottomEnabled = true, width, isShare },
    ref,
  ) => {
    const scrollViewRef = useRef<ScrollView>(null)
    // Whether new content should keep the bottom in view: set on send or on reaching the bottom, and
    // cleared only when the reader scrolls up. Off until then, so opening a thread does not move the reader.
    const followRef = useRef(false)
    const lastScrollTopRef = useRef(0)
    // Native only: the ScrollView's own height, to tell whether new content left the reader above the bottom.
    const viewportHeightRef = useRef(0)
    const [isAtBottom, setIsAtBottom] = useState(true)
    const sideMenuWidth = useSelector((state: RootState) => state.sideMenu.width)
    const { isSmallScreen, contentWidth } = useScreenInfo(sideMenuWidth)
    const theme = useSelector((state: RootState) => state.theme.theme)

    // On web the ScrollView grows to its content height and an ancestor (the overflow-y-auto View in
    // app/(app)/_layout.tsx) does the scrolling, so find whichever element really scrolls.
    const getWebScroller = (): HTMLElement | null => {
      let node: HTMLElement | null = scrollViewRef.current?.getScrollableNode() ?? null
      while (
        node &&
        !(/auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1)
      ) {
        node = node.parentElement
      }
      return node
    }

    const scrollToEnd = (animated = false): void => {
      followRef.current = true
      setIsAtBottom(true)
      if (Platform.OS !== 'web') {
        scrollViewRef.current?.scrollToEnd({ animated })
        return
      }
      getWebScroller()?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: animated ? 'smooth' : 'auto' })
    }

    const updateScrollPosition = useCallback((scrollTop: number, distanceToBottom: number): void => {
      const atBottom = distanceToBottom <= AT_BOTTOM_THRESHOLD_PX
      // Growing content widens the distance without moving scrollTop, so only an upward scroll means the
      // reader left the bottom; that is what stops the list from following them (issue #84: never move them).
      if (atBottom) followRef.current = true
      else if (scrollTop < lastScrollTopRef.current - 1) followRef.current = false
      lastScrollTopRef.current = scrollTop
      setIsAtBottom(atBottom)
    }, [])

    // Scroll events do not bubble, so listen in the capture phase for the ancestor that scrolls on web.
    useEffect(() => {
      if (Platform.OS !== 'web') return
      const onScroll = (event: Event): void => {
        const target = event.target
        const list: HTMLElement | null = scrollViewRef.current?.getScrollableNode() ?? null
        if (!(target instanceof HTMLElement) || !list || !target.contains(list)) return
        updateScrollPosition(target.scrollTop, target.scrollHeight - target.scrollTop - target.clientHeight)
      }
      document.addEventListener('scroll', onScroll, true)
      return () => document.removeEventListener('scroll', onScroll, true)
    }, [updateScrollPosition])

    // Sending is the reader's own action, so bring the new question and the thinking indicator into view.
    useEffect(() => {
      if (isSending) scrollToEnd()
      // scrollToEnd is recreated every render and only reads refs; this must run on isSending changes alone.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isSending])

    if (isLoading && !isSending) {
      return (
        <View testID='message-list-loading' className='flex-1 items-center justify-center'>
          <ActivityIndicator size='large' color={theme.hoverColor} />
        </View>
      )
    }
    // Scroll to Bottom Button component
    const ScrollToBottomButton = () => (
      // The page itself scrolls on web, so pin the button to the viewport there.
      <View className={`${Platform.OS === 'web' ? 'fixed bottom-[120px]' : 'absolute bottom-[25px]'} right-[24px]`}>
        <Pressable
          testID='scroll-to-bottom-button'
          accessibilityLabel='Scroll to bottom'
          className='rounded-[15px] p-[10px]'
          style={{
            backgroundColor: theme.sendIconColor,
          }}
          onPress={() => scrollToEnd(true)}
        >
          <ScrollToBottomIcon
            name='Scroll to Bottom'
            width={24}
            height={24}
            fill={theme.iconFill}
            hoverFill={theme.hoverColor}
          />
        </Pressable>
      </View>
    )

    const filteredMessages = (activeThread?.messages || []).filter((message) => typeof message.content === 'string')
    const lastAssistantMessageIndex = filteredMessages.findLastIndex((message) => message.role === UserRole.Assistant)
    const lastMessage = filteredMessages[filteredMessages.length - 1]
    const showThinkingIndicator = isSending && (!lastMessage || lastMessage.role === UserRole.User)

    return (
      <View className='flex-1'>
        <ScrollView
          ref={scrollViewRef}
          testID='message-list-scroll'
          className={`mb-${isSmallScreen ? '1' : '2'}`}
          scrollEventThrottle={100}
          onScroll={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) =>
            updateScrollPosition(contentOffset.y, contentSize.height - contentOffset.y - layoutMeasurement.height)
          }
          onLayout={({ nativeEvent }) => {
            viewportHeightRef.current = nativeEvent.layout.height
          }}
          onContentSizeChange={(_contentWidth: number, contentHeight: number) => {
            // Keep the newest text (a streaming answer, then its reaction row) in view unless the reader scrolled up.
            if (followRef.current) {
              scrollToEnd()
              return
            }
            if (Platform.OS !== 'web') {
              const scrollTop = lastScrollTopRef.current
              updateScrollPosition(scrollTop, contentHeight - scrollTop - viewportHeightRef.current)
              return
            }
            const scroller = getWebScroller()
            if (scroller) {
              updateScrollPosition(
                scroller.scrollTop,
                scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
              )
            }
          }}
        >
          {filteredMessages.map((message: Message, index) => {
            const id = message.id || Helpers.generateUniqueId() + (isSending ? '-sending' : '')

            return (
              <MessageBubbleMemo
                key={id}
                isSending={isSending}
                displayActivity={isSending && lastAssistantMessageIndex === index}
                isOutgoing={message.role === UserRole.User}
                message={message}
                threadId={String(activeThread?.id)}
                reactionsEnabled={reactionsEnabled}
                width={width}
                isShare={isShare}
              />
            )
          })}
          {showThinkingIndicator && (
            <View
              className={`mx-1 my-1 rounded flex flex-row flex-grow self-start ${isSmallScreen ? 'p-2 gap-2' : 'p-2.5 gap-4'}`}
              style={{ width: width || contentWidth }}
            >
              <View className='rounded px-5 py-2 w-8 h-8 items-center justify-center'>
                <ActivityIndicator size='small' color={theme.hoverColor} />
              </View>
            </View>
          )}
        </ScrollView>
        {!isAtBottom && scrollToBottomEnabled && <ScrollToBottomButton />}
      </View>
    )
  },
)

MessageList.displayName = 'MessageList'
export default MessageList
