import type { Metadata } from "next";
import Link from "next/link";
import { TERMS_DATE } from "@/lib/terms";

export const metadata: Metadata = { title: "Terms of Use · Lazy Boy" };

// The end-user agreement Spotify's Developer Terms (Section V) require: the "Spotify" section
// restates its minimum terms, in its own words where they are legal terms of art.
export default function TermsPage() {
  return (
    <>
      <h1>Terms of Use</h1>
      <p>Last updated {TERMS_DATE}.</p>
      <p>
        By asking to join or connecting your Spotify account to Lazy Boy you agree to these terms
        and to the{" "}
        <Link href="/privacy">Privacy Policy</Link>. If you don&apos;t agree, don&apos;t connect.
      </p>

      <h2>The app</h2>
      <ul>
        <li>
          Lazy Boy is a free, non-commercial app run by Rem Turatbekov. It works with your Spotify
          account and can change your playlists, Liked Songs and playback when you ask it to.
        </li>
        <li>
          It is provided as is, with no warranty of any kind. It may have bugs, change, or stop
          working at any time, and Rem may end anyone&apos;s access.
        </li>
        <li>
          To the fullest extent the law allows, Rem is not liable for any loss or damage from using
          it, including changes it makes to your Spotify library.
        </li>
        <li>Use it only with your own Spotify account, and within Spotify&apos;s own terms.</li>
      </ul>

      <h2>Spotify</h2>
      <ul>
        <li>
          Lazy Boy is not made, endorsed or supported by Spotify. Lazy Boy makes no warranties or
          representations on Spotify&apos;s behalf, and disclaims all implied warranties with
          respect to the Spotify Platform, the Spotify Service and Spotify Content, including the
          implied warranties of merchantability, fitness for a particular purpose and
          non-infringement.
        </li>
        <li>
          You may not modify or create derivative works based on the Spotify Platform, the Spotify
          Service or Spotify Content.
        </li>
        <li>
          You may not decompile, reverse-engineer, disassemble or otherwise reduce the Spotify
          Platform, the Spotify Service or Spotify Content to source code or other
          human-perceivable form, to the full extent allowed by law.
        </li>
        <li>
          Rem is responsible for Lazy Boy. Spotify and other third parties have no liability to
          you for it.
        </li>
        <li>
          Spotify is a third-party beneficiary of these terms and of the Privacy Policy, and is
          entitled to enforce these terms directly.
        </li>
      </ul>

      <h2>Leaving</h2>
      <p>
        Lazy Boy has room for five people, Rem included, and Rem decides who joins. You can log out
        or disconnect at any time; the <Link href="/privacy">Privacy Policy</Link> says how, and
        what happens to your data. Questions go to{" "}
        <a href="mailto:remtbkv@gmail.com">remtbkv@gmail.com</a>.
      </p>
    </>
  );
}
