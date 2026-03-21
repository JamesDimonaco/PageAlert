"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { X } from "lucide-react";
import type { MatchConditions } from "@prowl/shared";

interface MatchConditionsEditorProps {
  conditions: MatchConditions;
  onChange: (conditions: MatchConditions) => void;
}

function TagInput({
  tags,
  onChange,
  placeholder,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}) {
  const [input, setInput] = useState("");

  function addTag() {
    const val = input.trim().toLowerCase();
    if (val && !tags.includes(val)) {
      onChange([...tags, val]);
    }
    setInput("");
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2 min-h-[28px]">
        {tags.map((tag) => (
          <Badge key={tag} variant="outline" className="gap-1 pl-2.5 pr-1 text-xs font-normal">
            {tag}
            <button
              type="button"
              onClick={() => onChange(tags.filter((t) => t !== tag))}
              className="ml-0.5 rounded-full hover:bg-muted p-0.5"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>
      <Input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            addTag();
          }
          if (e.key === "Backspace" && !input && tags.length > 0) {
            onChange(tags.slice(0, -1));
          }
        }}
        placeholder={placeholder}
        className="h-8 text-sm"
      />
    </div>
  );
}

export function MatchConditionsEditor({ conditions, onChange }: MatchConditionsEditorProps) {
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label className="text-sm font-medium">Must include</Label>
        <p className="text-xs text-muted-foreground">Items must contain ALL of these keywords</p>
        <TagInput
          tags={conditions.mustInclude ?? []}
          onChange={(tags) => onChange({ ...conditions, mustInclude: tags })}
          placeholder="Type a keyword and press Enter"
        />
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium">Must not include</Label>
        <p className="text-xs text-muted-foreground">Items containing any of these will be excluded</p>
        <TagInput
          tags={conditions.mustExclude ?? []}
          onChange={(tags) => onChange({ ...conditions, mustExclude: tags })}
          placeholder="Type a keyword and press Enter"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label className="text-sm font-medium">Min price</Label>
          <Input
            type="number"
            value={conditions.priceMin ?? ""}
            onChange={(e) =>
              onChange({
                ...conditions,
                priceMin: e.target.value ? Number(e.target.value) : undefined,
              })
            }
            placeholder="No minimum"
            className="h-8 text-sm"
          />
        </div>
        <div className="space-y-2">
          <Label className="text-sm font-medium">Max price</Label>
          <Input
            type="number"
            value={conditions.priceMax ?? ""}
            onChange={(e) =>
              onChange({
                ...conditions,
                priceMax: e.target.value ? Number(e.target.value) : undefined,
              })
            }
            placeholder="No maximum"
            className="h-8 text-sm"
          />
        </div>
      </div>
    </div>
  );
}
