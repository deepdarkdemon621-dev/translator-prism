"use client";

import { ScrollArea } from "@/components/ui/scroll-area";

interface Chapter {
  id: string;
  index: number;
  title: string;
  status: string;
}

interface ChapterSidebarProps {
  chapters: Chapter[];
  currentIndex: number;
  onSelect: (index: number) => void;
  isOpen: boolean;
}

const STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  done: { icon: "●", color: "text-emerald-400/80" },
  translating: { icon: "◐", color: "text-amber-400/80" },
  pending: { icon: "○", color: "text-muted-foreground/50" },
  error: { icon: "✕", color: "text-destructive" },
};

export function ChapterSidebar({
  chapters,
  currentIndex,
  onSelect,
  isOpen,
}: ChapterSidebarProps) {
  return (
    <div
      className={`border-r border-border/50 bg-sidebar/50 backdrop-blur-sm overflow-hidden transition-all duration-300 ease-out ${
        isOpen ? "w-56 flex-shrink-0" : "w-0"
      }`}
    >
      <ScrollArea className="h-full">
        <div className="p-4 w-56">
          <div className="text-[10px] text-muted-foreground uppercase tracking-[0.18em] mb-3 font-sans font-medium">
            Table of Contents
          </div>
          <div className="space-y-0.5">
            {chapters.map((ch) => {
              const isCurrent = ch.index === currentIndex;
              const statusInfo = STATUS_ICONS[ch.status] || STATUS_ICONS.pending;

              return (
                <button
                  key={ch.id}
                  className={`group relative block w-full text-left text-sm py-2 pl-3 pr-2 rounded-md transition-all duration-200 ${
                    isCurrent
                      ? "text-foreground bg-accent/60"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent/30"
                  }`}
                  onClick={() => onSelect(ch.index)}
                >
                  {isCurrent && (
                    <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-primary" />
                  )}
                  <span className="flex items-center gap-2 min-w-0">
                    <span className={`${statusInfo.color} text-[10px] shrink-0`}>
                      {statusInfo.icon}
                    </span>
                    <span className={`truncate ${isCurrent ? "font-medium" : ""}`}>
                      {ch.title}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
