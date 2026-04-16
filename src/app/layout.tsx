import type { Metadata } from "next";
import { Noto_Serif_JP, Noto_Serif_SC, Fraunces } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { GlobalQuotaBanner } from "@/components/GlobalQuotaBanner";
import "./globals.css";

const notoJp = Noto_Serif_JP({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-noto-jp",
  display: "swap",
});

const notoSc = Noto_Serif_SC({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-noto-sc",
  display: "swap",
});

// Fraunces — expressive variable serif used for headings and brand marks.
// Using the full variable font (no fixed weights) so we can drive it via CSS
// `font-weight` and the SOFT / opsz axes give it personality for large display.
const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  display: "swap",
  axes: ["SOFT", "opsz"],
});

export const metadata: Metadata = {
  title: "Prism — One book, many languages",
  description: "A polyglot EPUB reader with AI translation, built-in dictionaries, and SRS vocabulary review.",
};

// Inlined script that runs before hydration to apply the user's saved theme
// class on <html>, avoiding a flash of the default theme. Must be a string
// (not a React component) so it executes synchronously in <head>.
const THEME_INIT_SCRIPT = `
(function(){try{
  var s=localStorage.getItem('reader-prefs.v1');
  var t=s?(JSON.parse(s).theme||'dark'):'dark';
  var e=document.documentElement;
  e.classList.remove('theme-dark','theme-light','theme-sepia','dark');
  e.classList.add('theme-'+t);
  if(t==='dark')e.classList.add('dark');
}catch(e){document.documentElement.classList.add('theme-dark','dark');}})();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider>
      <html lang="ja" suppressHydrationWarning>
        <head>
          <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        </head>
        <body
          className={`${notoJp.variable} ${notoSc.variable} ${fraunces.variable} antialiased bg-background text-foreground`}
        >
          <ConfirmProvider>
            <GlobalQuotaBanner />
            {children}
          </ConfirmProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
