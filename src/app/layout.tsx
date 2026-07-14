import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jarvis for LinkedIn",
  description: "Voice-controlled LinkedIn assistant",
};

// Runs before paint so the saved theme applies with no flash of the wrong one.
const THEME_INIT = `
try {
  var t = localStorage.getItem('jarvis-theme');
  if (!t) t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
} catch (e) {
  document.documentElement.setAttribute('data-theme', 'dark');
}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body className="min-h-screen bg-[#08080b] text-zinc-200 antialiased light:bg-[#f7f7fa] light:text-zinc-800">
        {children}
      </body>
    </html>
  );
}
