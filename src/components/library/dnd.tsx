"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

export type DragItemType = "book" | "collection";

/**
 * Shared pointer sensor for library drag-and-drop. The 8px activation
 * distance keeps plain clicks (open book, dropdown menus, selection
 * checkboxes) working — a drag only starts after actual movement.
 */
export function useLibraryDndSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );
}

/**
 * Grid/list item wrapper that makes its children sortable. Collection
 * items double as drop targets for book drags (drag a top-level book onto
 * a collection card to move it in); they highlight while a book hovers.
 */
export function SortableGridItem({
  id,
  type,
  disabled,
  className,
  style,
  children,
  as: Tag = "div",
  onClick,
}: {
  id: string;
  type: DragItemType;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
  as?: "div" | "li";
  onClick?: React.MouseEventHandler;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
    active,
  } = useSortable({ id, data: { type }, disabled });

  const bookOverCollection =
    type === "collection" && isOver && active?.data.current?.type === "book";

  // Releasing a drag still dispatches a native click on the element under
  // the pointer, which would open the book/collection link inside. Arm a
  // guard while dragging and swallow that one click in the capture phase;
  // it clears on the next tick so ordinary clicks keep working even when
  // the drag ended off-element and no click followed.
  const suppressClickRef = useRef(false);
  useEffect(() => {
    if (isDragging) {
      suppressClickRef.current = true;
      return;
    }
    if (suppressClickRef.current) {
      const t = setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      return () => clearTimeout(t);
    }
  }, [isDragging]);

  return (
    <Tag
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClickCapture={(e) => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onClick={onClick}
      className={className}
      style={{
        ...style,
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.55 : undefined,
        position: isDragging ? "relative" : undefined,
        zIndex: isDragging ? 10 : undefined,
        borderRadius: "0.75rem",
        boxShadow: bookOverCollection
          ? "0 0 0 2px var(--color-primary, #8b5e3c)"
          : undefined,
        touchAction: disabled ? undefined : "manipulation",
      }}
    >
      {children}
    </Tag>
  );
}
