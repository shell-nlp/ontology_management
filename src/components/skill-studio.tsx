"use client";

import { useEffect, useState } from "react";
import { Boxes, Download, FileText, PackageCheck, Sparkles, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { downloadResponse } from "@/lib/clipboard";
import "./skill-studio.css";

/**
 * 本体技能：把「怎么建一个本体」写成 AI 助手能直接用的技能包，放在平台里看得见、拿得走。
 *
 * 这一页**刻意只给清单**——编号、名称、适用场景、主要产物。技能正文不进页面：
 * 想看细节就整套下载（zip 解压进去就是一个能装进 Agent 技能目录的文件夹）。
 * 结构对标 bkn-studio 的「AI Skills 构建」，区别是技能内容就在本平台里，不指向外部仓库。
 */

type SkillSummary = {
  id: string;
  stage: number;
  title: string;
  scenario: string;
  outputs: string;
  icon: "requirement" | "builder" | "bundle";
  files: { path: string; bytes: number; entry: boolean }[];
};

const ICONS = { requirement: FileText, builder: Boxes, bundle: PackageCheck } as const;


export function SkillStudio({ notify, fail }: { notify: (text: string) => void; fail: (reason: unknown) => void }) {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    api<{ skills: SkillSummary[]; hint: string | null }>("/api/skills")
      .then((data) => { setSkills(data.skills); setHint(data.hint); })
      .catch((reason) => { setSkills([]); fail(reason); });
  }, [fail]);

  const download = async (url: string, name: string, message: string) => {
    try {
      await downloadResponse(url, name);
      notify(message);
    } catch (reason) {
      fail(reason);
    }
  };

  return (
    <section className="stack">
      <div className="panel functional-panel">
        <div className="title-row">
          <div>
            <span className="eyebrow">本体技能</span>
            <h2>AI Skills 辅助构建本体</h2>
          </div>
          <div className="functional-actions">
            <button className="action primary" onClick={() => setModalOpen(true)}><Sparkles size={16} />获取 Skills</button>
          </div>
        </div>
        <p className="subtle">
          从业务材料出发，用三套技能完成需求澄清、本体设计和出包交付；产物是<b>可以直接导入平台的本体包 JSON</b>
          （<code>format: ontology.bundle</code>）。要看技能全文就整套下载 —— 解压后放进 Agent 的技能目录即可。
        </p>
      </div>

      <ol className="sk-flow">
        {(skills ?? []).map((skill) => {
          const Icon = ICONS[skill.icon];
          return (
            <li key={skill.id} className="sk-flow-item">
              <span className="sk-stage">{skill.stage}</span>
              <span className="sk-flow-icon" aria-hidden><Icon size={17} /></span>
              <div className="sk-flow-body">
                <div className="sk-flow-title">
                  <h3>{skill.title} Skill</h3>
                  <span aria-hidden>：</span>
                  <code>{skill.id}</code>
                </div>
                <dl className="sk-flow-desc">
                  <div>
                    <dt>适用场景</dt>
                    <dd>{skill.scenario}</dd>
                  </div>
                  <div>
                    <dt>主要产物</dt>
                    <dd>{skill.outputs}</dd>
                  </div>
                </dl>
              </div>
            </li>
          );
        })}
      </ol>
      {skills?.length === 0 && <p className="sk-empty">{hint ?? "技能目录里没有内容。"}</p>}

      {modalOpen && (
        <div className="dialog-backdrop" role="presentation" onClick={() => setModalOpen(false)}>
          <div className="dialog sk-modal" role="dialog" aria-modal="true" aria-label="获取 Skills" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="close-button" onClick={() => setModalOpen(false)} title="关闭"><X size={18} /></button>
            <div className="dialog-icon"><Sparkles size={22} /></div>
            <span className="eyebrow">获取 Skills</span>
            <h2>把技能装进你的 Agent</h2>
            <p className="sk-modal-note">
              技能是一组 Markdown 文件，不需要装依赖、也不需要连平台。下载后解压到 Agent 的技能目录：
              Codex 是 <code>~/.codex/skills/&lt;技能名&gt;/SKILL.md</code>，
              通用目录是 <code>~/.agents/skills/&lt;技能名&gt;/SKILL.md</code>，重启会话即可使用。
            </p>
            <div className="sk-install-list">
              {(skills ?? []).map((skill) => (
                <section key={skill.id} className="sk-install-item">
                  <b>{skill.stage}. {skill.title} Skill</b>
                  <code>{skill.id}</code>
                  <p>{skill.scenario}</p>
                </section>
              ))}
            </div>
            <div className="sk-install-foot">
              <span>三套技能打在一个包里，解压出来就是三个技能目录。</span>
              <button
                className="action primary"
                onClick={() => void download("/api/skills/archive", "ontology-skills.zip", "已下载全部 Skills：解压后把三个目录放进 Agent 的技能目录即可。")}
              >
                <Download size={15} />下载全部 Skills (.zip)
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}