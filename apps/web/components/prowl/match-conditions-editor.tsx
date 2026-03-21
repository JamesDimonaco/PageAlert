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
  label,
  tags,
  onChange,
  placeholder,
}: {
  label: string;
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}) {
  const [input, setInput] = useState("");

  function addTag() {
    const val = input.trim();
    if (val && !tags.includes(val)) {
      onChange([...tags, val]);
    }
    setInput("");
  }

  return (
    <div className="space-y-2">
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      <div className="flex flex-wrap gap-1.5 min-h-[32px]">
        {tags.map((tag) => (
          <Badge
            key={tag}
            variant="outline"
            className="gap-1 pl-2 pr-1 text-xs"
          >
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
        placeholder={placeholder ?? "Type and press Enter"}
        className="h-8 text-sm"
      />
    </div>
  );
}

export function MatchConditionsEditor({
  conditions,
  onChange,
}: MatchConditionsEditorProps) {
  return (
    <div className="space-y-5">
      <TagInput
        label="Title must contain"
        tags={conditions.titleContains ?? []}
        onChange={(tags) => onChange({ ...conditions, titleContains: tags })}
        placeholder="e.g. MacBook Pro"
      />
      <TagInput
        label="Title must NOT contain"
        tags={conditions.titleExcludes ?? []}
        onChange={(tags) => onChange({ ...conditions, titleExcludes: tags })}
        placeholder="e.g. refurbished"
      />
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label className="text-xs font-medium text-muted-foreground">Min price</Label>
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
          <Label className="text-xs font-medium text-muted-foreground">Max price</Label>
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
      <TagInput
        label="Must include (anywhere)"
        tags={conditions.mustInclude ?? []}
        onChange={(tags) => onChange({ ...conditions, mustInclude: tags })}
        placeholder="e.g. 14-inch"
      />
      <TagInput
        label="Must exclude (anywhere)"
        tags={conditions.mustExclude ?? []}
        onChange={(tags) => onChange({ ...conditions, mustExclude: tags })}
        placeholder="e.g. used"
      />
    </div>
  );
}
