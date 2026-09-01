import { Entity, PrimaryColumn, Column, UpdateDateColumn } from "typeorm";

@Entity("ports")
export class RTSPPortEntity {
  @PrimaryColumn({ type: "text" })
  did!: string;

  @Column({ type: "text" })
  slug!: string;

  @Column({ type: "integer" })
  port!: number;

  @UpdateDateColumn()
  updatedAt!: Date;
}
