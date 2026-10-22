import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Privacy Policy · Lazy Boy" };

// Every statement here must be true of the code as it runs today (Spotify Developer Terms,
// Section V: "a complete and accurate disclosure"). Change the code, change this page.
export default function PrivacyPage() {
  return (
    <>
      <h1>Privacy Policy</h1>
      <p>Last updated October 21, 2026.</p>
      <p>
        Lazy Boy is a free, non-commercial app that Rem Turatbekov runs for himself and a few
        friends. This page says what it does with your data. Lazy Boy collects and uses your data
        only as this policy describes, and connecting your Spotify account means you agree to it
        and to the <Link href="/terms">Terms of Use</Link>.
      </p>

      <h2>What it collects</h2>
      <p>
        When you connect, Spotify asks you to let Lazy Boy see your profile, read and change your
        playlists and Liked Songs, see and control what is playing, and read what you recently
        played. From that, the app stores:
      </p>
      <ul>
        <li>your Spotify user ID, and a random ID Lazy Boy gives your account;</li>
        <li>
          your listening history: each song you play, when it ended, and the playlist or album it
          played from, read from Spotify every couple of minutes, including while the app is
          closed; and what the app works out from it: whether each play was a skip (you heard
          less than 40% of the song) and your listening totals;
        </li>
        <li>
          a copy of your playlists (names, covers, their owners&apos; Spotify IDs, songs, their
          order and when each was added) and your Liked Songs (and when each was added);
        </li>
        <li>song details: title, artist, album, cover-art link and length;</li>
        <li>
          the sign-in tokens Spotify issues, so the app can act for you without asking you to sign
          in again every hour;
        </li>
        <li>your timezone offset, so your days start at your midnight;</li>
        <li>
          diagnostic logs, tagged with your account&apos;s random ID and kept 30 days: each call
          the app makes to Spotify (time, address, result and which part of the app made it); what
          your browser reports about each page of the app you open (load timings, how long the
          page stayed in view, which page of the app you went to next, and error messages), with a
          random ID for the browser tab; how long a song change took to show; and, when a song
          ends while Home is open, the Spotify IDs of that song and the one before it, when it
          ended, how long it played, how far into it Home saw it get and how Home judged it; for a
          song played in a private session, only that it was private and how long it played.
          Errors the server runs into are logged by page and message, with no account&apos;s ID.
        </li>
      </ul>
      <p>
        Spotify also passes along your display name, profile picture and, if it provides one, your
        email address. They are kept in your sign-in cookie to show your name and picture; the
        database does not keep them.
      </p>

      <h2>Why</h2>
      <p>
        Only to run the app for you: to show your history, listening time and library back to
        you, to search them, and to do what you ask (merge, clean or compare playlists, queue or
        play songs).
      </p>

      <h2>Cookies and browser storage</h2>
      <p>
        Lazy Boy sets a sign-in cookie that keeps you signed in for up to 30 days, short-lived
        cookies used during the Spotify sign-in, and a cookie holding your timezone offset. It
        also keeps caches in your browser so pages and search open faster: small ones in local
        and session storage, and a copy of your library and listening history in IndexedDB;
        signing out clears them. There are no ads, analytics or tracking cookies, and Lazy Boy lets no one else place cookies in
        your browser. Album art loads directly from Spotify&apos;s servers. You can delete these
        cookies and caches in your browser&apos;s settings at any time; deleting the sign-in
        cookie signs you out.
      </p>

      <h2>Where it is kept</h2>
      <ul>
        <li>
          The app runs on Vercel, which sees each request (including your IP address) as any web
          host does. Vercel also keeps cached copies of some of what your pages show, labelled
          with your account&apos;s random ID, so pages open faster, and its logs hold the errors
          and warnings the server prints.
        </li>
        <li>
          Your history, library, timezone and sign-in tokens are in a database on Turso, a hosted
          database in AWS&apos;s US East region.
        </li>
        <li>
          The diagnostic logs are on a computer Rem owns, at his home, reached over
          Tailscale&apos;s network.
        </li>
        <li>
          Nightly backup copies of the database and of the diagnostic logs, with the sign-in
          tokens removed, are kept on that computer for 14 days and in Rem&apos;s Microsoft
          OneDrive for 60 days.
        </li>
        <li>
          Rem uses an AI assistant (Anthropic&apos;s Claude) to maintain the app. It works only
          with Rem&apos;s own data and never reads yours.
        </li>
      </ul>

      <h2>Who it is shared with</h2>
      <p>
        No one. Lazy Boy shows no ads, sells nothing, passes nothing to advertisers or data
        brokers, and never uses your Spotify data to train an AI model. The services listed above
        hold or carry it only to run the app.
      </p>

      <h2>How long it is kept</h2>
      <p>
        For as long as you stay connected; your history builds up over that time. If you
        disconnect, everything Lazy Boy holds about you, backups included, is deleted within five
        days.
      </p>

      <h2>Disconnecting and deletion</h2>
      <p>
        To disconnect, remove Lazy Boy at{" "}
        <a href="https://www.spotify.com/account/apps/">spotify.com/account/apps</a> (Manage
        apps, then Remove access); from then on the app cannot read anything from your account.
        Then email Rem at <a href="mailto:remtbkv@gmail.com">remtbkv@gmail.com</a> to have your
        data deleted, and it is gone within five days.
      </p>

      <h2>Children</h2>
      <p>
        Lazy Boy is not for children under 13. If Rem learns an account belongs to a child under
        13, he disconnects it and deletes its data.
      </p>

      <h2>Contact and changes</h2>
      <p>
        Questions about your data go to <a href="mailto:remtbkv@gmail.com">remtbkv@gmail.com</a>.
        If this policy changes, the date at the top changes with it. Spotify is a third-party
        beneficiary of this policy.
      </p>
    </>
  );
}
