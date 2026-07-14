// Friends. Still unbuilt, so the page's only job is to say what it will do — in the user's
// terms. It deliberately does NOT cite internal docs or file paths: nobody using the app can
// open those, so naming them is noise at best and confusing at worst.
//
// This page is a constant. It has no data, no session-dependent output, nothing to await — so
// it is NOT force-dynamic and does not call auth(): it's prerendered and served from the
// static payload. (The route is still gated — the (app) layout does the auth.) It was
// previously paying for a dynamic render + a JWT decode to display fixed text.

const COMING = [
  {
    title: "Compare libraries",
    body: "If they also use this app, you can see which songs each of you is missing. Can do stuff with this like save the difference straight to a playlist.",
  },
  {
    title: "Queue song for friend",
    body: "Kinda fun. The receiving user doesn't even need to be actively playing anything at the moment, it will just be the next thing they see when they open up spotify. Has limits of course, like you can put yourself on DND and whatnot.",
  },
  {
    title: "More stuff I forgot about",
    body: "",
  },
];

export default function FriendsPage() {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-28 pt-7 sm:px-6 sm:pb-20 sm:pt-6">
      <h1 className="den-display text-4xl leading-tight tracking-tight sm:text-5xl">
        Later stuff
      </h1>

      {/* Ruled rows, not cards — a border has to earn its place, and these are prose. */}
      <ul className="mt-8 max-w-2xl divide-y divide-border/60 border-t border-border/60">
        {COMING.map((f) => (
          <li key={f.title} className="py-5">
            <p className="text-[15px]">{f.title}</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
