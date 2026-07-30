# 独立的 PostgreSQL Schema

平台在已有 PostgreSQL 数据库的 `ontology_platform` Schema 中保存自己的表。该命名空间隔离账号、目标、草稿、发布记录和审计日志，避免影响现有业务表，并使迁移、权限与备份范围保持清晰。
