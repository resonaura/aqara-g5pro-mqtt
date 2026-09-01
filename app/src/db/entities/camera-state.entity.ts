import { Entity, PrimaryColumn, Column, UpdateDateColumn, CreateDateColumn } from "typeorm";

@Entity("cameras")
export class CameraStateEntity {
  @PrimaryColumn({ type: "text" })
  did!: string;

  @Column({ type: "text", nullable: true })
  slug?: string;

  @Column({ type: "text", nullable: true })
  deviceName?: string;

  @Column({ type: "text", nullable: true })
  model?: string;

  @Column({ type: "boolean", default: false })
  p2p_stream!: boolean;

  @Column({ type: "integer", nullable: true })
  quality_channel?: number;

  @Column({ type: "boolean", default: true })
  motion_enabled!: boolean;

  @Column({ type: "text", nullable: true })
  spotlight_state?: string;

  @Column({ type: "integer", nullable: true })
  spotlight_brightness?: number;

  @Column({ type: "integer", nullable: true })
  rtsp_port?: number;

  @Column({ type: "simple-json", nullable: true })
  extra?: Record<string, any>;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
