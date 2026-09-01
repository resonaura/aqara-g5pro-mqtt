import { Entity, PrimaryColumn, Column, UpdateDateColumn } from "typeorm";

@Entity("settings")
export class GlobalSettingEntity {
  @PrimaryColumn({ type: "text" })
  key!: string;

  @Column({ type: "text" })
  value!: string;

  @UpdateDateColumn()
  updatedAt!: Date;
}
