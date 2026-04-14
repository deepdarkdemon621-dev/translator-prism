"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface VocabularyEntry {
  id: string;
  word: string;
  lang: string;
  reading: string | null;
  gloss: string;
  note: string | null;
  sourceBookId: string | null;
  sourceContext: string | null;
  stage: number;
  nextReviewAt: string | null;
  lastReviewedAt: string | null;
  correctCount: number;
  incorrectCount: number;
  createdAt: string;
  updatedAt: string;
}

interface VocabularyEditDialogProps {
  entry: VocabularyEntry | null;
  onClose: () => void;
  onSaved: () => void;
}

export function VocabularyEditDialog({
  entry,
  onClose,
  onSaved,
}: VocabularyEditDialogProps) {
  const [word, setWord] = useState("");
  const [reading, setReading] = useState("");
  const [gloss, setGloss] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (entry) {
      setWord(entry.word);
      setReading(entry.reading ?? "");
      setGloss(entry.gloss);
      setNote(entry.note ?? "");
      setError(null);
    }
  }, [entry]);

  const handleSave = async () => {
    if (!entry) return;
    if (!word.trim() || !gloss.trim()) {
      setError("Word and gloss are required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/vocabulary/${entry.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          word: word.trim(),
          reading: reading.trim() || null,
          gloss: gloss.trim(),
          note: note.trim() || null,
        }),
      });
      if (!res.ok) throw new Error("Save failed");
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const isOpen = entry !== null;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit vocabulary entry</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          <div>
            <Label htmlFor="vocab-word" className="mb-2 block">Word</Label>
            <Input
              id="vocab-word"
              value={word}
              onChange={(e) => setWord(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="vocab-reading" className="mb-2 block">Reading</Label>
            <Input
              id="vocab-reading"
              value={reading}
              onChange={(e) => setReading(e.target.value)}
              placeholder="optional"
            />
          </div>
          <div>
            <Label htmlFor="vocab-gloss" className="mb-2 block">Gloss</Label>
            <Input
              id="vocab-gloss"
              value={gloss}
              onChange={(e) => setGloss(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="vocab-note" className="mb-2 block">Note</Label>
            <Input
              id="vocab-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="optional"
            />
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
