import Link from "next/link";

export default function Home() {
  return (
    <main className="landing">
      <h1>File hosting</h1>
      <p>
        <Link href="/login">Sign in</Link>
      </p>
    </main>
  );
}
