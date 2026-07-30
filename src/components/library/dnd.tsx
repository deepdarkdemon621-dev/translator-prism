"use client";

import type { CSSProperties, ReactNode } from "react";
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

  return (
    <Tag
      ref={setNodeRef}
      {...attributes}
      {...listeners}
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
