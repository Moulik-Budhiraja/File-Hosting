import Link from "next/link";

export default function Home() {
  return (
    <main className="landing">
      <h1>File hosting</h1>
      <p>This service hosts files uploaded with the fs CLI.</p>
      <p>
        Preview URLs use <code>/{"{id}"}</code>; raw bytes use{" "}
        <code>/raw/{"{id}"}</code>.
      </p>
      <p>
        <Link href="/login">Sign in</Link> to manage files, API keys, and users.
      </p>
    </main>
  );
}
