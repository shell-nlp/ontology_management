import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ontology | 本体管理平台",
  description: "Apache Jena 本体建模、实例管理与 SPARQL 工作台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
