import { Card, CardContent } from "@/components/ui/card";
import { Star } from "lucide-react";

interface Testimonial {
  quote: string;
  name: string;
  role: string;
  stars: number;
}

// These will be replaced with real user reviews as they come in
const TESTIMONIALS: Testimonial[] = [
  {
    quote: "I was manually checking Apple's refurbished page every day. Now PageAlert does it for me and texts me on Telegram when a deal appears. Saved me £200 on a MacBook.",
    name: "James D.",
    role: "Developer",
    stars: 5,
  },
  {
    quote: "Set up 3 monitors for rental properties in Bristol. Got notified about a new listing within hours of it going live — before it even hit the main search results.",
    name: "Early user",
    role: "Property hunter",
    stars: 5,
  },
  {
    quote: "The AI actually understands what I'm looking for. I just wrote 'React developer remote over $100k' and it matched the right job listings. No CSS selectors needed.",
    name: "Early user",
    role: "Job seeker",
    stars: 4,
  },
];

export function Testimonials() {
  return (
    <section className="border-t border-border/30">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-16 sm:py-28">
        <div className="mx-auto max-w-2xl text-center mb-12 sm:mb-16">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight leading-tight">
            What people are saying
          </h2>
          <p className="mt-4 text-muted-foreground leading-relaxed">
            Early feedback from our first users
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-3 max-w-5xl mx-auto">
          {TESTIMONIALS.map((t, i) => (
            <Card key={i} className="border-border/30 bg-card/50 shadow-sm">
              <CardContent className="p-6">
                <div className="flex gap-0.5 mb-4">
                  {Array.from({ length: 5 }).map((_, j) => (
                    <Star
                      key={j}
                      className={`h-4 w-4 ${j < t.stars ? "text-amber-400 fill-amber-400" : "text-muted-foreground/20"}`}
                    />
                  ))}
                </div>
                <p className="text-sm leading-relaxed text-foreground/80 mb-4">
                  &ldquo;{t.quote}&rdquo;
                </p>
                <div>
                  <p className="text-sm font-semibold">{t.name}</p>
                  <p className="text-xs text-muted-foreground">{t.role}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
