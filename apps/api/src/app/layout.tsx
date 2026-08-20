export const metadata = {
  title: 'Ansari Backend API',
  description: 'Ansari: Islamic AI assistant API',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
