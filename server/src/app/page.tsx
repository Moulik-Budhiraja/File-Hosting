export default function Home() {
  return (
    <main>
      <h1>File hosting</h1>
      <p>This service hosts files uploaded with the fs CLI.</p>
      <p>
        Preview URLs use <code>/{"{id}"}</code>; raw bytes use{" "}
        <code>/raw/{"{id}"}</code>.
      </p>
    </main>
  );
}
