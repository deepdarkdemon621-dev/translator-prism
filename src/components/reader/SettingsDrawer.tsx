"use client";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import type { ReaderPrefs } from "@/lib/reader/prefs";

// Kept as an alias for backward compat with any imports of the old name.
export type ReaderSettings = ReaderPrefs;

interface SettingsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  settings: ReaderPrefs;
  onSettingsChange: (settings: ReaderPrefs) => void;
}

const FONT_OPTIONS = {
  ja: [
    { label: "Noto Serif JP", value: "var(--font-noto-jp), serif" },
    { label: "Sans-serif", value: "system-ui, sans-serif" },
  ],
  zh: [
    { label: "Noto Serif SC", value: "var(--font-noto-sc), serif" },
    { label: "Sans-serif", value: "system-ui, sans-serif" },
  ],
  en: [
    { label: "Georgia", value: "Georgia, serif" },
    { label: "Times New Roman", value: "'Times New Roman', serif" },
    { label: "Sans-serif", value: "system-ui, sans-serif" },
  ],
};

const SPACING_OPTIONS = [
  { label: "Compact", value: "compact" },
  { label: "Standard", value: "standard" },
  { label: "Relaxed", value: "relaxed" },
];

export function SettingsDrawer({
  isOpen,
  onClose,
  settings,
  onSettingsChange,
}: SettingsDrawerProps) {
  const update = (partial: Partial<ReaderPrefs>) => {
    onSettingsChange({ ...settings, ...partial });
  };
  const updateFont = (lang: keyof ReaderPrefs["fonts"], value: string) => {
    onSettingsChange({ ...settings, fonts: { ...settings.fonts, [lang]: value } });
  };

  return (
    <Sheet open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent>
        <SheetHeader><SheetTitle>Reading Settings</SheetTitle></SheetHeader>
        <div className="space-y-6 mt-6 px-4 pb-4 overflow-y-auto flex-1">
          {/* Font Size */}
          <div>
            <Label className="mb-2 block">Font Size: {settings.fontSize}px</Label>
            <Slider
              aria-label="Font size"
              value={[settings.fontSize]}
              min={12}
              max={28}
              step={1}
              onValueChange={(v) => {
                const val = Array.isArray(v) ? v[0] : v;
                if (val !== undefined) update({ fontSize: val });
              }}
            />
          </div>
          {/* Line Height */}
          <div>
            <Label className="mb-2 block">Line Height: {settings.lineHeight}x</Label>
            <Slider
              aria-label="Line height"
              value={[settings.lineHeight * 10]}
              min={12}
              max={30}
              step={1}
              onValueChange={(v) => {
                const val = Array.isArray(v) ? v[0] : v;
                if (val !== undefined) update({ lineHeight: val / 10 });
              }}
            />
          </div>
          {/* Paragraph Spacing */}
          <div>
            <Label id="label-paragraph-spacing" className="mb-2 block">Paragraph Spacing</Label>
            <Select
              value={settings.paragraphSpacing}
              onValueChange={(v) => {
                if (v !== null) update({ paragraphSpacing: v as ReaderPrefs["paragraphSpacing"] });
              }}
            >
              <SelectTrigger aria-labelledby="label-paragraph-spacing" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SPACING_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {/* Immersive reading: unknown-word highlighting (ja source only) */}
          <div className="flex items-center justify-between">
            <Label htmlFor="highlight-unknown" className="block">
              Highlight unknown words
            </Label>
            <input
              id="highlight-unknown"
              type="checkbox"
              className="h-4 w-4 accent-[var(--primary)] cursor-pointer"
              checked={settings.highlightUnknown}
              onChange={(e) => update({ highlightUnknown: e.target.checked })}
            />
          </div>
          <Separator />
          {/* Fonts per language */}
          {(["ja", "zh", "en"] as const).map((lang) => (
            <div key={lang}>
              <Label id={`label-font-${lang}`} className="mb-2 block">
                {lang === "ja" ? "Japanese Font" : lang === "zh" ? "Chinese Font" : "English Font"}
              </Label>
              <Select
                value={settings.fonts[lang]}
                onValueChange={(v) => { if (v !== null) updateFont(lang, v); }}
              >
                <SelectTrigger aria-labelledby={`label-font-${lang}`} className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FONT_OPTIONS[lang].map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
          <Separator />
          {/* Theme */}
          <div>
            <Label id="label-theme" className="mb-2 block">Theme</Label>
            <Select
              value={settings.theme}
              onValueChange={(v) => {
                if (v !== null) update({ theme: v as ReaderPrefs["theme"] });
              }}
            >
              <SelectTrigger aria-labelledby="label-theme" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="sepia">Sepia</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
